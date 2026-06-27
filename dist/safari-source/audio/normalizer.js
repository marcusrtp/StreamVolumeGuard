(function initNormalizer(root) {
  const WLG = root.StreamVolumeGuard = root.StreamVolumeGuard || {};
  const Analyser = WLG.Analyser;
  const Settings = WLG.Settings;
  const Limiter = WLG.Limiter;
  const StreamStatus = WLG.StreamStatus;
  const TRANSITION_DUCK_GAIN = 0.03;
  const TRANSITION_DUCK_RAMP_SECONDS = 0.01;
  const TRANSITION_RECOVER_DELAY_SECONDS = 0.018;
  const TRANSITION_RECOVER_TIME_CONSTANT = 0.032;
  const OUTPUT_TRIM_DEADBAND_DB = 0.06;
  const OUTPUT_ESTIMATE_HOLD_MS = 1000;

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
    const boostCatchupMs = !reducing && gapDb > 24 ? 260 : releaseMs;
    const timeConstant = Math.max(1, reducing ? attackMs : boostCatchupMs);
    const alpha = 1 - Math.exp(-Math.max(0, elapsedMs) / timeConstant);
    return currentGainDb + (targetGainDb - currentGainDb) * alpha;
  }

  function configureCompressor(compressor, profile) {
    compressor.threshold.value = profile.compressorThresholdDb;
    compressor.knee.value = profile.compressorKneeDb;
    compressor.ratio.value = profile.compressorRatio;
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
    let outputAnalyser = null;
    let compressor = null;
    let limiter = null;
    const buffer = new Float32Array(2048);
    const outputBuffer = new Float32Array(2048);
    const callbacks = hooks || {};

    let rafId = null;
    let timerId = null;
    let stopped = false;
    let lastTime = context.currentTime;
    let currentGainDb = 0;
    let currentOutputTrimDb = 0;
    let lastRmsDb = Analyser.MIN_DB;
    let previousInputRmsDb = Analyser.MIN_DB;
    let outputRmsDb = Analyser.MIN_DB;
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

    function graphNodes() {
      return [
        source,
        analyser,
        autoGain,
        dryGain,
        wetGain,
        outputTrimGain,
        outputGain,
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
      outputGain.connect(outputAnalyser);
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
      outputAnalyser = Analyser.createAnalyserNode(context, 2048);
      compressor = context.createDynamicsCompressor();
      limiter = Limiter.createSafetyLimiter(context, profile.limiterCeilingDb);

      configureCompressor(compressor, profile);
      configureLimiter(limiter, profile.limiterCeilingDb);
      autoGain.gain.value = 1;
      dryGain.gain.value = processingEnabled ? 0 : 1;
      wetGain.gain.value = processingEnabled ? 1 : 0;
      outputTrimGain.gain.value = 1;
      outputGain.gain.value = panicActive ? Analyser.dbToLinear(runtimeSettings.panicGainDb || -30) : 1;
      connectGraph();
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

    function readOutputRmsDb() {
      const estimatedOutputRmsDb = getEstimatedOutputRmsDb();
      if (!outputAnalyser) return estimatedOutputRmsDb;

      const measuredOutputRmsDb = Analyser.getAnalyserRmsDb(outputAnalyser, outputBuffer);
      return measuredOutputRmsDb > Analyser.MIN_DB + 1 ? measuredOutputRmsDb : estimatedOutputRmsDb;
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
      if (inputJumpDb >= 12) {
        resetOutputTrim(0.012, true);
        outputTrimHoldUntilMs = context.currentTime * 1000 + 900;
        return true;
      }
      return false;
    }

    function updateOutputTrim(measuredOutputRmsDb, elapsedMs) {
      if (!processingEnabled || !outputTrimGain || measuredOutputRmsDb <= Analyser.MIN_DB + 1) {
        resetOutputTrim(0.04);
        return;
      }

      const correctionDb = profile.targetRmsDb - measuredOutputRmsDb;
      const correctionStepDb = Analyser.clamp(correctionDb * 0.35, -2.5, 2.5);
      const targetTrimDb = Math.abs(correctionDb) < OUTPUT_TRIM_DEADBAND_DB
        ? currentOutputTrimDb
        : Analyser.clamp(currentOutputTrimDb + correctionStepDb, -12, 6);
      const reducing = targetTrimDb < currentOutputTrimDb;
      const timeConstant = reducing ? Math.max(25, profile.attackMs) : Math.max(220, profile.releaseMs * 0.45);
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
      const outputWouldOvershoot = processingEnabled &&
        predictedOutputBeforeSmoothingDb > profile.targetRmsDb + 1.2;
      const shouldDuckTransition = processingEnabled &&
        (levelJumped || outputWouldOvershoot) &&
        targetGainDb < currentGainDb - 1;
      const shouldSnapGain = outputWouldOvershoot ||
        (levelJumped && targetGainDb < currentGainDb - 1);
      if (shouldSnapGain) {
        preferEstimatedOutputUntilMs = Math.max(
          preferEstimatedOutputUntilMs,
          now * 1000 + OUTPUT_ESTIMATE_HOLD_MS
        );
      }

      currentGainDb = shouldSnapGain
        ? targetGainDb
        : smoothGainDb(
            currentGainDb,
            targetGainDb,
            elapsedMs,
            profile.attackMs,
            profile.releaseMs
          );

      duckTransitionOutput(now, shouldDuckTransition);
      const linearGain = Analyser.dbToLinear(currentGainDb);
      if (shouldSnapGain) {
        rampParamToValue(autoGain.gain, linearGain, 0.012);
      } else {
        autoGain.gain.setTargetAtTime(linearGain, context.currentTime, 0.035);
      }
      const measuredOutputRmsDb = readOutputRmsDb();
      const preferEstimatedOutput = now * 1000 < preferEstimatedOutputUntilMs;
      outputRmsDb = preferEstimatedOutput ? getTransitionOutputRmsDb() : measuredOutputRmsDb;
      if (now * 1000 < outputTrimHoldUntilMs) {
        resetOutputTrim(0.012, true);
        currentGainDb = shouldSnapGain
          ? targetGainDb
          : smoothGainDb(
              currentGainDb,
              targetGainDb,
              elapsedMs,
              profile.attackMs,
              profile.releaseMs
            );
        const heldLinearGain = Analyser.dbToLinear(currentGainDb);
        if (shouldSnapGain) {
          rampParamToValue(autoGain.gain, heldLinearGain, 0.012);
        } else {
          autoGain.gain.setTargetAtTime(heldLinearGain, context.currentTime, 0.035);
        }
        outputRmsDb = preferEstimatedOutput ? getTransitionOutputRmsDb() : getEstimatedOutputRmsDb();
      } else {
        updateOutputTrim(measuredOutputRmsDb, elapsedMs);
        outputRmsDb = preferEstimatedOutput ? getTransitionOutputRmsDb() : readOutputRmsDb();
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

      if (root.requestAnimationFrame) {
        rafId = root.requestAnimationFrame(step);
      } else {
        timerId = root.setTimeout(step, 100);
      }
    }

    async function start() {
      await ensureContextRunning();
      ensureGraphStarted();
      step();
      report(true);
    }

    function stop() {
      stopped = true;
      if (rafId && root.cancelAnimationFrame) root.cancelAnimationFrame(rafId);
      if (timerId) root.clearTimeout(timerId);
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

    function updateSettings(nextSettings) {
      const previousTargetRmsDb = profile.targetRmsDb;
      runtimeSettings = Settings.normalizeSettings(nextSettings);
      profile = Settings.getRuntimeProfile(runtimeSettings);
      if (graphStarted) {
        configureCompressor(compressor, profile);
        configureLimiter(limiter, profile.limiterCeilingDb);
        connectGraph();
        if (
          processingEnabled &&
          previousTargetRmsDb !== profile.targetRmsDb &&
          Number.isFinite(lastRmsDb) &&
          lastRmsDb > Analyser.MIN_DB + 1
        ) {
          currentGainDb = calculateTargetGainDb({
            currentRmsDb: lastRmsDb,
            targetRmsDb: profile.targetRmsDb,
            maxBoostDb: profile.maxBoostDb,
            maxReductionDb: profile.maxReductionDb
          });
          resetOutputTrim(0.02);
          outputRmsDb = getEstimatedOutputRmsDb();
          predictedPeakDb = lastPeakDb + currentGainDb;
          autoGain.gain.setTargetAtTime(Analyser.dbToLinear(currentGainDb), context.currentTime, 0.02);
        }
      }
      setPanic(panicActive);
      report(true);
    }

    function getState() {
      return {
        gainDb: Number(currentGainDb.toFixed(2)),
        rmsDb: Number(lastRmsDb.toFixed(2)),
        outputRmsDb: Number(outputRmsDb.toFixed(2)),
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
