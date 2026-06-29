(function initNormalizer(root) {
  const WLG = root.StreamVolumeGuard = root.StreamVolumeGuard || {};
  const Analyser = WLG.Analyser;
  const Settings = WLG.Settings;
  const Limiter = WLG.Limiter;
  const StreamStatus = WLG.StreamStatus;
  const TRANSITION_DUCK_GAIN = 0.12;
  const TRANSITION_DUCK_RAMP_SECONDS = 0.012;
  const TRANSITION_RECOVER_DELAY_SECONDS = 0.016;
  const TRANSITION_RECOVER_TIME_CONSTANT = 0.026;
  const OUTPUT_TRIM_DEADBAND_DB = 0.06;
  const OUTPUT_ESTIMATE_HOLD_MS = 1000;
  const JUMP_OUTPUT_ESTIMATE_HOLD_MS = 1700;
  const JUMP_OUTPUT_TRIM_HOLD_MS = 1400;
  const AUTO_GAIN_HOLD_RAMP_SECONDS = 0.045;
  const AUTO_GAIN_RAMP_SECONDS = 0.018;
  const SETTINGS_GAIN_RAMP_SECONDS = AUTO_GAIN_RAMP_SECONDS;
  const SETTINGS_APPLY_COOLDOWN_MS = 950;
  const JUMP_DETECT_DB = 14;
  const SETTINGS_REENTRY_RAMP_SECONDS = 0.08;
  const SETTINGS_REENTRY_GRACE_MS = 750;
  const CONTROL_LOOP_INTERVAL_MS = 100;
  const MEDIA_SEEK_GATE_GAIN = 0.0001;
  const MEDIA_SEEK_GATE_DOWN_SECONDS = 0.012;
  const MEDIA_SEEK_GATE_UP_SECONDS = 0.05;
  const MEDIA_SEEK_GATE_HOLD_MS = 20;

  function calculateTargetGainDb(options) {
    const currentRmsDb = Number(options.currentRmsDb);
    const targetRmsDb = Number(options.targetRmsDb);
    const maxBoostDb = Number(options.maxBoostDb);
    const maxReductionDb = Number(options.maxReductionDb);

    if (!Number.isFinite(currentRmsDb) || currentRmsDb <= Analyser.MIN_DB + 1) {
      return 0;
    }

    const rawGain = targetRmsDb - currentRmsDb;
    return Analyser.clamp(rawGain, maxReductionDb, maxBoostDb);
  }

  function smoothGainDb(currentGainDb, targetGainDb, elapsedMs, attackMs, releaseMs) {
    const reducing = targetGainDb < currentGainDb;
    const gapDb = Math.abs(targetGainDb - currentGainDb);
    const boostCatchupMs = !reducing
      ? (gapDb > 24 ? 90 : currentGainDb > 12 && gapDb > 6 ? 220 : releaseMs)
      : releaseMs;
    const timeConstant = Math.max(1, reducing ? attackMs : boostCatchupMs);
    const alpha = 1 - Math.exp(-Math.max(0, elapsedMs) / timeConstant);
    return currentGainDb + (targetGainDb - currentGainDb) * alpha;
  }

  function configureCompressor(compressor, profile) {
    compressor.threshold.value = 0;
    compressor.knee.value = 0;
    compressor.ratio.value = 1;
    compressor.attack.value = Math.max(0.003, profile.attackMs / 1000);
    compressor.release.value = Math.max(0.05, profile.releaseMs / 1000);
  }

  function configureLimiter(limiter, ceilingDb) {
    const ceiling = Number.isFinite(Number(ceilingDb)) ? Number(ceilingDb) : Limiter.DEFAULT_CEILING_DB;
    limiter.limiter.threshold.value = ceiling;
    limiter.ceilingGain.gain.value = 1;
    limiter.ceilingDb = ceiling;
  }

  function disconnectNode(node) {
    if (!node) return;
    try {
      node.disconnect();
    } catch (error) {
      // A node can already be disconnected when reconfiguring the live graph.
    }
  }

  function createMediaNormalizer(media, settings, hooks) {
    const AudioContextClass = root.AudioContext || root.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("AudioContext is not available in this browser context.");
    }

    let runtimeSettings = Settings.normalizeSettings(settings);
    let profile = Settings.getRuntimeProfile(runtimeSettings);
    const context = new AudioContextClass();
    let source = null;
    let analyser = null;
    let autoGain = null;
    let dryGain = null;
    let wetGain = null;
    let outputTrimGain = null;
    let outputGain = null;
    let mediaSeekGate = null;
    let outputAnalyser = null;
    let compressor = null;
    let limiter = null;
    const buffer = new Float32Array(2048);
    const outputBuffer = new Float32Array(2048);
    const callbacks = hooks || {};

    let rafId = null;
    let timerId = null;
    let stepScheduleId = 0;
    let stopped = false;
    let lastTime = context.currentTime;
    let currentGainDb = 0;
    let currentOutputTrimDb = 0;
    let lastRmsDb = Analyser.MIN_DB;
    let previousInputRmsDb = Analyser.MIN_DB;
    let outputRmsDb = Analyser.MIN_DB;
    let outputPeakDb = Analyser.MIN_DB;
    let outputTrimHoldUntilMs = 0;
    let preferEstimatedOutputUntilMs = 0;
    let lastPeakDb = Analyser.MIN_DB;
    let predictedPeakDb = Analyser.MIN_DB;
    let riskLevel = "safe";
    let riskUntilMs = 0;
    let containedPeakCount = 0;
    let lastContainedPeakAt = 0;
    let lastReportAt = 0;
    let processingEnabled = runtimeSettings.enabled;
    let panicActive = false;
    let graphStarted = false;
    let settingsApplyTimer = null;
    let pendingSettingsForApply = null;
    let lastSettingsApplyMs = 0;
    let settingsReentryUntilMs = 0;
    let mediaSeekReleaseTimer = null;

    function graphNodes() {
      return [
        source,
        analyser,
        autoGain,
        dryGain,
        wetGain,
        outputTrimGain,
        outputGain,
        mediaSeekGate,
        outputAnalyser,
        compressor,
        limiter && limiter.output
      ].filter(Boolean);
    }

    function connectGraph() {
      graphNodes().forEach(disconnectNode);

      source.connect(analyser);
      analyser.connect(autoGain);
      analyser.connect(dryGain);
      dryGain.connect(outputGain);

      if (runtimeSettings.compressorEnabled) {
        autoGain.connect(compressor);
        if (runtimeSettings.limiterEnabled) {
          compressor.connect(limiter.input);
          limiter.output.connect(wetGain);
        } else {
          compressor.connect(wetGain);
        }
      } else if (runtimeSettings.limiterEnabled) {
        autoGain.connect(limiter.input);
        limiter.output.connect(wetGain);
      } else {
        autoGain.connect(wetGain);
      }
      wetGain.connect(outputTrimGain);
      outputTrimGain.connect(outputGain);
      outputGain.connect(mediaSeekGate);
      mediaSeekGate.connect(outputAnalyser);
      outputAnalyser.connect(context.destination);
    }

    function createBlockedContextError() {
      const error = new Error("AudioContext blocked by the browser. Click inside the page, then activate StreamVolume Guard again.");
      error.retryable = true;
      return error;
    }

    async function ensureContextRunning() {
      if (context.state === "suspended") {
        await context.resume();
      }
      if (context.state !== "running") {
        throw createBlockedContextError();
      }
    }

    function cancelScheduledValues(param) {
      if (!param) return;
      if (typeof param.cancelAndHoldAtTime === "function") {
        try {
          param.cancelAndHoldAtTime(context.currentTime);
          return;
        } catch (error) {
          // Older engines can expose the method but reject it for some params.
        }
      }
      if (typeof param.cancelScheduledValues === "function") {
        param.cancelScheduledValues(context.currentTime);
      }
    }

    function rampParamToValue(param, value, rampSeconds) {
      if (!param) return;
      cancelScheduledValues(param);
      if (typeof param.setValueAtTime === "function") {
        param.setValueAtTime(param.value, context.currentTime);
      }
      if (typeof param.linearRampToValueAtTime === "function") {
        param.linearRampToValueAtTime(value, context.currentTime + rampSeconds);
      } else if (typeof param.setTargetAtTime === "function") {
        param.setTargetAtTime(value, context.currentTime, Math.max(0.006, rampSeconds));
      } else {
        param.value = value;
      }
    }

    function ensureGraphStarted() {
      if (graphStarted) return;

      source = context.createMediaElementSource(media);
      analyser = Analyser.createAnalyserNode(context, 2048);
      autoGain = context.createGain();
      dryGain = context.createGain();
      wetGain = context.createGain();
      outputTrimGain = context.createGain();
      outputGain = context.createGain();
      mediaSeekGate = context.createGain();
      outputAnalyser = Analyser.createAnalyserNode(context, 2048);
      outputAnalyser.smoothingTimeConstant = 0.15;
      compressor = context.createDynamicsCompressor();
      limiter = Limiter.createSafetyLimiter(context, profile.limiterCeilingDb);

      configureCompressor(compressor, profile);
      configureLimiter(limiter, profile.limiterCeilingDb);
      autoGain.gain.value = 1;
      dryGain.gain.value = processingEnabled ? 0 : 1;
      wetGain.gain.value = processingEnabled ? 1 : 0;
      outputTrimGain.gain.value = 1;
      outputGain.gain.value = panicActive ? Analyser.dbToLinear(runtimeSettings.panicGainDb || -30) : 1;
      mediaSeekGate.gain.value = 1;
      connectGraph();
      addMediaDiscontinuityListeners();
      graphStarted = true;
    }

    function report(force) {
      const nowMs = Date.now();
      if (!force && nowMs - lastReportAt < 250) return;
      lastReportAt = nowMs;
      if (callbacks.onState) {
        callbacks.onState({
          gainDb: Number(currentGainDb.toFixed(2)),
          rmsDb: Number(lastRmsDb.toFixed(2)),
          outputRmsDb: Number(outputRmsDb.toFixed(2)),
          outputPeakDb: Number(outputPeakDb.toFixed(2)),
          peakDb: Number(lastPeakDb.toFixed(2)),
          predictedPeakDb: Number(predictedPeakDb.toFixed(2)),
          riskLevel,
          containedPeakCount,
          profileId: profile.id,
          targetRmsDb: profile.targetRmsDb,
          maxBoostDb: profile.maxBoostDb,
          limiterCeilingDb: profile.limiterCeilingDb,
          panicActive
        });
      }
    }

    function getEstimatedOutputRmsDb() {
      return processingEnabled ? lastRmsDb + currentGainDb + currentOutputTrimDb : lastRmsDb;
    }

    function getEstimatedOutputPeakDb() {
      const estimatedPeakDb = processingEnabled
        ? lastPeakDb + currentGainDb + currentOutputTrimDb
        : lastPeakDb;
      return processingEnabled
        ? Analyser.clamp(estimatedPeakDb, profile.targetRmsDb - 1.1, profile.targetRmsDb + 3)
        : estimatedPeakDb;
    }

    function readOutputRmsDb() {
      const estimatedOutputRmsDb = getEstimatedOutputRmsDb();
      if (!outputAnalyser) return estimatedOutputRmsDb;

      const measuredOutputRmsDb = Analyser.getAnalyserRmsDb(outputAnalyser, outputBuffer);
      return measuredOutputRmsDb > Analyser.MIN_DB + 1 ? measuredOutputRmsDb : estimatedOutputRmsDb;
    }

    function readOutputPeakDb() {
      const estimatedOutputPeakDb = getEstimatedOutputPeakDb();
      if (!outputAnalyser) return estimatedOutputPeakDb;

      outputAnalyser.getFloatTimeDomainData(outputBuffer);
      const measuredOutputPeakDb = Analyser.calculatePeakDb(outputBuffer);
      return measuredOutputPeakDb > Analyser.MIN_DB + 1 ? measuredOutputPeakDb : estimatedOutputPeakDb;
    }

    function getTransitionOutputRmsDb() {
      return Analyser.clamp(
        getEstimatedOutputRmsDb(),
        profile.targetRmsDb - 1.1,
        profile.targetRmsDb + 0.2
      );
    }

    function resetOutputTrim(timeConstant, snap) {
      currentOutputTrimDb = 0;
      if (outputTrimGain) {
        if (snap) {
          rampParamToValue(outputTrimGain.gain, 1, 0.012);
        } else {
          cancelScheduledValues(outputTrimGain.gain);
          outputTrimGain.gain.setTargetAtTime(1, context.currentTime, timeConstant);
        }
      }
    }

    function duckTransitionOutput(now, shouldDuck) {
      if (!processingEnabled || !wetGain || !shouldDuck) return;
      rampParamToValue(wetGain.gain, TRANSITION_DUCK_GAIN, TRANSITION_DUCK_RAMP_SECONDS);
      wetGain.gain.setTargetAtTime(1, now + TRANSITION_RECOVER_DELAY_SECONDS, TRANSITION_RECOVER_TIME_CONSTANT);
    }

    function clearScheduledStep() {
      if (rafId && root.cancelAnimationFrame) {
        root.cancelAnimationFrame(rafId);
      }
      if (timerId) {
        root.clearTimeout(timerId);
      }
      rafId = null;
      timerId = null;
    }

    function isDocumentHidden() {
      return Boolean(root.document && root.document.hidden);
    }

    function scheduleStep() {
      const scheduleId = ++stepScheduleId;

      function run() {
        if (stopped || scheduleId !== stepScheduleId) return;
        clearScheduledStep();
        step();
      }

      if (isDocumentHidden() || !root.requestAnimationFrame) {
        timerId = root.setTimeout(run, CONTROL_LOOP_INTERVAL_MS);
      } else {
        rafId = root.requestAnimationFrame(run);
      }
    }

    function clearMediaSeekReleaseTimer() {
      if (!mediaSeekReleaseTimer) return;
      root.clearTimeout(mediaSeekReleaseTimer);
      mediaSeekReleaseTimer = null;
    }

    function duckMediaDiscontinuity() {
      if (!mediaSeekGate) return;
      clearMediaSeekReleaseTimer();
      rampParamToValue(mediaSeekGate.gain, MEDIA_SEEK_GATE_GAIN, MEDIA_SEEK_GATE_DOWN_SECONDS);
    }

    function releaseMediaDiscontinuity() {
      if (!mediaSeekGate) return;
      clearMediaSeekReleaseTimer();
      mediaSeekReleaseTimer = root.setTimeout(() => {
        mediaSeekReleaseTimer = null;
        if (stopped || !mediaSeekGate) return;
        rampParamToValue(mediaSeekGate.gain, 1, MEDIA_SEEK_GATE_UP_SECONDS);
      }, MEDIA_SEEK_GATE_HOLD_MS);
    }

    function addMediaDiscontinuityListeners() {
      if (!media.addEventListener) return;
      media.addEventListener("loadstart", duckMediaDiscontinuity);
      media.addEventListener("seeking", duckMediaDiscontinuity);
      media.addEventListener("loadeddata", releaseMediaDiscontinuity);
      media.addEventListener("seeked", releaseMediaDiscontinuity);
      media.addEventListener("playing", releaseMediaDiscontinuity);
      media.addEventListener("canplay", releaseMediaDiscontinuity);
    }

    function removeMediaDiscontinuityListeners() {
      if (!media.removeEventListener) return;
      media.removeEventListener("loadstart", duckMediaDiscontinuity);
      media.removeEventListener("seeking", duckMediaDiscontinuity);
      media.removeEventListener("loadeddata", releaseMediaDiscontinuity);
      media.removeEventListener("seeked", releaseMediaDiscontinuity);
      media.removeEventListener("playing", releaseMediaDiscontinuity);
      media.removeEventListener("canplay", releaseMediaDiscontinuity);
    }

    function handleVisibilityChange() {
      if (stopped || !isDocumentHidden() || timerId) return;
      clearScheduledStep();
      scheduleStep();
    }

    function handleLevelJump(nextRmsDb) {
      if (
        !processingEnabled ||
        previousInputRmsDb <= Analyser.MIN_DB + 1 ||
        nextRmsDb <= Analyser.MIN_DB + 1
      ) {
        previousInputRmsDb = nextRmsDb;
        return false;
      }

      const inputJumpDb = Math.abs(nextRmsDb - previousInputRmsDb);
      previousInputRmsDb = nextRmsDb;
      if (inputJumpDb >= JUMP_DETECT_DB) {
        resetOutputTrim(0.02, true);
        outputTrimHoldUntilMs = context.currentTime * 1000 + 900;
        preferEstimatedOutputUntilMs = context.currentTime * 1000 + JUMP_OUTPUT_ESTIMATE_HOLD_MS;
        return true;
      }
      return false;
    }

    function updateOutputTrim(measuredOutputRmsDb, elapsedMs, targetGainDb) {
      if (!processingEnabled || !outputTrimGain || measuredOutputRmsDb <= Analyser.MIN_DB + 1) {
        resetOutputTrim(0.04);
        return;
      }

      const estimatedOutputRmsDb = getEstimatedOutputRmsDb();
      const highBoostSignal = targetGainDb >= 24;
      const controlOutputRmsDb = highBoostSignal
        ? Math.max(measuredOutputRmsDb, estimatedOutputRmsDb - 0.9)
        : measuredOutputRmsDb;
      const correctionDb = profile.targetRmsDb - controlOutputRmsDb;
      const remainingBoostHeadroomDb = Math.max(0, profile.maxBoostDb - targetGainDb);
      const allowUpwardTrim = !highBoostSignal || remainingBoostHeadroomDb >= 1.5;
      const maxTrimDb = highBoostSignal ? Math.min(0.9, remainingBoostHeadroomDb) : 3;
      const minTrimDb = targetGainDb > 0 && targetGainDb < 24 ? -1.5 : -12;
      const correctionStepDb = correctionDb > 0 && allowUpwardTrim
        ? Analyser.clamp(correctionDb * 0.55, 0, 4)
        : correctionDb < 0
          ? Analyser.clamp(correctionDb * 0.35, -2.5, 0)
          : 0;
      let targetTrimDb = Math.abs(correctionDb) < OUTPUT_TRIM_DEADBAND_DB
        ? currentOutputTrimDb
        : Analyser.clamp(currentOutputTrimDb + correctionStepDb, minTrimDb, maxTrimDb);
      if (!allowUpwardTrim && targetTrimDb > 0) {
        targetTrimDb = 0;
      }
      const reducing = targetTrimDb < currentOutputTrimDb;
      const outputTooWeak = correctionDb > 1;
      const timeConstant = reducing
        ? Math.max(25, profile.attackMs)
        : outputTooWeak && allowUpwardTrim
          ? (highBoostSignal ? 140 : 120)
          : Math.max(180, profile.releaseMs * 0.35);
      currentOutputTrimDb = smoothGainDb(
        currentOutputTrimDb,
        targetTrimDb,
        elapsedMs,
        timeConstant,
        timeConstant
      );
      outputTrimGain.gain.setTargetAtTime(
        Analyser.dbToLinear(currentOutputTrimDb),
        context.currentTime,
        0.045
      );
    }

    function step() {
      if (stopped) return;
      const now = context.currentTime;
      const elapsedMs = Math.max(16, (now - lastTime) * 1000);
      lastTime = now;

      lastRmsDb = Analyser.getAnalyserRmsDb(analyser, buffer);
      const levelJumped = handleLevelJump(lastRmsDb);
      lastPeakDb = Analyser.calculatePeakDb(buffer);
      const targetGainDb = processingEnabled
        ? calculateTargetGainDb({
            currentRmsDb: lastRmsDb,
            targetRmsDb: profile.targetRmsDb,
            maxBoostDb: profile.maxBoostDb,
            maxReductionDb: profile.maxReductionDb
          })
        : 0;
      const predictedOutputBeforeSmoothingDb = lastRmsDb + currentGainDb + currentOutputTrimDb;
      const gainDeltaForSnapDb = Math.abs(targetGainDb - currentGainDb);
      const shouldForceCatchup = gainDeltaForSnapDb > 16;
      const outputWouldOvershoot = processingEnabled &&
        predictedOutputBeforeSmoothingDb > profile.targetRmsDb + 1.2;
      const safeBoostSnap = processingEnabled &&
        levelJumped &&
        targetGainDb > currentGainDb + 18 &&
        lastRmsDb < profile.targetRmsDb - 18;
      const shouldDuckTransition = processingEnabled &&
        (levelJumped || outputWouldOvershoot) &&
        targetGainDb < currentGainDb - 1;
      const inSettingsReconfig = now * 1000 < settingsReentryUntilMs;
      const shouldSnapGain = !inSettingsReconfig && (
        outputWouldOvershoot ||
        levelJumped ||
        shouldForceCatchup ||
        (levelJumped && targetGainDb < currentGainDb - 1) ||
        safeBoostSnap
      );
      if (shouldSnapGain || inSettingsReconfig) {
        preferEstimatedOutputUntilMs = Math.max(preferEstimatedOutputUntilMs, now * 1000 + OUTPUT_ESTIMATE_HOLD_MS);
        outputTrimHoldUntilMs = Math.max(outputTrimHoldUntilMs, now * 1000 + JUMP_OUTPUT_TRIM_HOLD_MS);
      }
      const autoGainRampSeconds = shouldSnapGain ? AUTO_GAIN_HOLD_RAMP_SECONDS : AUTO_GAIN_RAMP_SECONDS;
      const gainAttackMs = profile.attackMs;
      const gainReleaseMs = profile.releaseMs;
      const settingsSmoothingElapsedMs = inSettingsReconfig ? Math.max(elapsedMs, 220) : elapsedMs;
      const smoothedGainDb = shouldSnapGain
        ? targetGainDb
        : smoothGainDb(
            currentGainDb,
            targetGainDb,
            settingsSmoothingElapsedMs,
            gainAttackMs,
            gainReleaseMs
          );
      const snapSettingsSafeSeconds = inSettingsReconfig ? SETTINGS_GAIN_RAMP_SECONDS : autoGainRampSeconds;

      currentGainDb = smoothedGainDb;

      duckTransitionOutput(now, shouldDuckTransition);
      const linearGain = Analyser.dbToLinear(currentGainDb);
      if (shouldSnapGain || inSettingsReconfig) {
        rampParamToValue(autoGain.gain, linearGain, snapSettingsSafeSeconds);
      } else {
        autoGain.gain.setTargetAtTime(linearGain, context.currentTime, AUTO_GAIN_RAMP_SECONDS);
      }
      const measuredOutputRmsDb = readOutputRmsDb();
      const measuredOutputPeakDb = readOutputPeakDb();
      const preferEstimatedOutput = now * 1000 < preferEstimatedOutputUntilMs;
      outputRmsDb = preferEstimatedOutput ? getTransitionOutputRmsDb() : measuredOutputRmsDb;
      outputPeakDb = preferEstimatedOutput ? getEstimatedOutputPeakDb() : measuredOutputPeakDb;
      if (now * 1000 < outputTrimHoldUntilMs) {
        if (targetGainDb <= 0) {
          resetOutputTrim(0.02, true);
        } else {
          const trimMeasurementDb = targetGainDb >= 24
            ? Math.min(measuredOutputRmsDb, getEstimatedOutputRmsDb())
            : measuredOutputRmsDb;
          updateOutputTrim(trimMeasurementDb, elapsedMs, targetGainDb);
        }
        const heldLinearGain = Analyser.dbToLinear(currentGainDb);
        if (shouldSnapGain || inSettingsReconfig) {
          rampParamToValue(autoGain.gain, heldLinearGain, AUTO_GAIN_HOLD_RAMP_SECONDS);
        } else {
          autoGain.gain.setTargetAtTime(heldLinearGain, context.currentTime, AUTO_GAIN_RAMP_SECONDS);
        }
        outputRmsDb = preferEstimatedOutput ? getTransitionOutputRmsDb() : getEstimatedOutputRmsDb();
        outputPeakDb = preferEstimatedOutput ? getEstimatedOutputPeakDb() : getEstimatedOutputPeakDb();
      } else {
          updateOutputTrim(measuredOutputRmsDb, elapsedMs, targetGainDb);
          outputRmsDb = preferEstimatedOutput ? getTransitionOutputRmsDb() : readOutputRmsDb();
          outputPeakDb = preferEstimatedOutput ? getEstimatedOutputPeakDb() : readOutputPeakDb();
        }

      predictedPeakDb = processingEnabled ? lastPeakDb + currentGainDb + currentOutputTrimDb : lastPeakDb;
      const wasRisky = riskLevel === "risky";
      const risk = StreamStatus.nextRiskState({
        peakDb: lastPeakDb,
        predictedPeakDb,
        ceilingDb: profile.limiterCeilingDb,
        rmsDb: lastRmsDb,
        targetRmsDb: profile.targetRmsDb,
        nowMs: now * 1000,
        previousRiskUntilMs: riskUntilMs
      });
      riskLevel = processingEnabled ? risk.level : "safe";
      riskUntilMs = processingEnabled ? risk.riskUntilMs : 0;

      if (
        processingEnabled &&
        !panicActive &&
        runtimeSettings.limiterEnabled &&
        StreamStatus.shouldCountContainedPeak({
          predictedPeakDb,
          ceilingDb: profile.limiterCeilingDb
        }) &&
        now * 1000 - lastContainedPeakAt > 350
      ) {
        containedPeakCount += 1;
        lastContainedPeakAt = now * 1000;
      }

      report((levelJumped || outputWouldOvershoot) || (riskLevel === "risky" && !wasRisky));

      scheduleStep();
    }

    async function start() {
      await ensureContextRunning();
      ensureGraphStarted();
      if (root.document && root.document.addEventListener) {
        root.document.addEventListener("visibilitychange", handleVisibilityChange);
      }
      step();
      report(true);
    }

    function stop() {
      stopped = true;
      if (settingsApplyTimer) {
        root.clearTimeout(settingsApplyTimer);
        settingsApplyTimer = null;
      }
      clearMediaSeekReleaseTimer();
      removeMediaDiscontinuityListeners();
      if (root.document && root.document.removeEventListener) {
        root.document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      clearScheduledStep();
      graphNodes().forEach((node) => {
        try {
          node.disconnect();
        } catch (error) {
          // Disconnection can fail if the browser already detached the node.
        }
      });
      if (context.state !== "closed") {
        context.close();
      }
    }

    function setEnabled(nextEnabled) {
      processingEnabled = Boolean(nextEnabled);
      if (!graphStarted) {
        report(true);
        return;
      }
      const now = context.currentTime;
      dryGain.gain.setTargetAtTime(processingEnabled ? 0 : 1, now, 0.04);
      wetGain.gain.setTargetAtTime(processingEnabled ? 1 : 0, now, 0.04);
      if (!processingEnabled) {
        currentGainDb = 0;
        previousInputRmsDb = Analyser.MIN_DB;
        resetOutputTrim(0.04);
        outputTrimHoldUntilMs = 0;
        outputRmsDb = lastRmsDb;
        outputPeakDb = lastPeakDb;
        predictedPeakDb = lastPeakDb;
        riskLevel = "safe";
        riskUntilMs = 0;
        autoGain.gain.setTargetAtTime(1, now, 0.04);
      }
      report(true);
    }

    function setPanic(nextActive) {
      panicActive = Boolean(nextActive);
      if (!graphStarted) {
        report(true);
        return;
      }
      const panicGain = Analyser.dbToLinear(runtimeSettings.panicGainDb || -30);
      outputGain.gain.setTargetAtTime(panicActive ? panicGain : 1, context.currentTime, 0.008);
      report(true);
    }

    function applySettingsNow(nextSettings) {
      const previousTargetRmsDb = profile.targetRmsDb;
      runtimeSettings = Settings.normalizeSettings(nextSettings);
      profile = Settings.getRuntimeProfile(runtimeSettings);
      if (graphStarted) {
        configureCompressor(compressor, profile);
        configureLimiter(limiter, profile.limiterCeilingDb);
        connectGraph();
        resetOutputTrim(0.04, false);
        preferEstimatedOutputUntilMs = Math.max(preferEstimatedOutputUntilMs, context.currentTime * 1000 + OUTPUT_ESTIMATE_HOLD_MS);
        outputTrimHoldUntilMs = Math.max(outputTrimHoldUntilMs, context.currentTime * 1000 + JUMP_OUTPUT_TRIM_HOLD_MS);
        settingsReentryUntilMs = context.currentTime * 1000 + SETTINGS_REENTRY_GRACE_MS;
        if (
          processingEnabled &&
          previousTargetRmsDb !== profile.targetRmsDb &&
          Number.isFinite(lastRmsDb) &&
          lastRmsDb > Analyser.MIN_DB + 1
        ) {
          const nextGainDb = calculateTargetGainDb({
            currentRmsDb: lastRmsDb,
            targetRmsDb: profile.targetRmsDb,
            maxBoostDb: profile.maxBoostDb,
            maxReductionDb: profile.maxReductionDb
          });
          const smoothedEntryGainDb = smoothGainDb(
            currentGainDb,
            nextGainDb,
            0,
            profile.attackMs,
            profile.releaseMs
          );
          currentGainDb = smoothedEntryGainDb;
          outputRmsDb = getEstimatedOutputRmsDb();
          outputPeakDb = lastPeakDb + currentGainDb + currentOutputTrimDb;
          predictedPeakDb = lastPeakDb + currentGainDb;
          autoGain.gain.setTargetAtTime(
            Analyser.dbToLinear(currentGainDb),
            context.currentTime,
            SETTINGS_REENTRY_RAMP_SECONDS
          );
        }
      }

      setPanic(panicActive);
      report(true);
    }

    function updateSettings(nextSettings) {
      pendingSettingsForApply = nextSettings;
      const nowMs = Date.now();
      if (settingsApplyTimer) {
        root.clearTimeout(settingsApplyTimer);
        settingsApplyTimer = null;
      }

      const delayMs = Math.max(0, SETTINGS_APPLY_COOLDOWN_MS - (nowMs - lastSettingsApplyMs));
      settingsApplyTimer = root.setTimeout(() => {
        settingsApplyTimer = null;
        const pendingSettings = pendingSettingsForApply;
        if (!pendingSettings) return;

        pendingSettingsForApply = null;
        lastSettingsApplyMs = Date.now();
        applySettingsNow(pendingSettings);
      }, delayMs);
    }

    function getState() {
      return {
        gainDb: Number(currentGainDb.toFixed(2)),
        rmsDb: Number(lastRmsDb.toFixed(2)),
        outputRmsDb: Number(outputRmsDb.toFixed(2)),
        outputPeakDb: Number(outputPeakDb.toFixed(2)),
        peakDb: Number(lastPeakDb.toFixed(2)),
        predictedPeakDb: Number(predictedPeakDb.toFixed(2)),
        riskLevel,
        containedPeakCount,
        profileId: profile.id,
        maxBoostDb: profile.maxBoostDb,
        targetRmsDb: profile.targetRmsDb,
        contextState: context.state,
        processingEnabled,
        panicActive
      };
    }

    return {
      start,
      stop,
      setEnabled,
      setPanic,
      updateSettings,
      getState,
      nodes: {
        context,
        source,
        analyser,
        autoGain,
        dryGain,
        wetGain,
        outputTrimGain,
        outputGain,
        outputAnalyser,
        compressor,
        limiter
      }
    };
  }

  WLG.Normalizer = {
    calculateTargetGainDb,
    smoothGainDb,
    createMediaNormalizer
  };
})(globalThis);
