import test from 'node:test';
import assert from 'node:assert/strict';

// stopKind 内部使用 window.setTimeout 延迟回收轨道，Node 环境需要补齐
globalThis.window = { setTimeout: (fn, ms) => setTimeout(fn, ms) };

const { createSoundscapeManager } = await import(
  '../src/frontend/public/haitong/assets/js/soundscape-manager.mjs'
);

const VOICE_URL = 'fake/voice.mp3';

function createGainParam() {
  return { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} };
}

function createFakeNode() {
  return { gain: createGainParam(), pan: { value: 0 }, type: '', frequency: { value: 0 }, Q: { value: 0 }, connect() {}, disconnect() {} };
}

function createFakeAudioElement() {
  const listeners = {};
  return {
    preload: '',
    playsInline: false,
    crossOrigin: '',
    src: '',
    playbackRate: 1,
    loop: false,
    play: () => new Promise(() => {}),
    pause() {},
    load() {},
    removeAttribute() {},
    appendChild() {},
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    dispatch(type) {
      (listeners[type] || []).slice().forEach(handler => handler());
    },
  };
}

function createTestManager() {
  const manager = createSoundscapeManager({
    documentRef: { createElement: () => createFakeAudioElement() },
    fadeMs: 10,
  });
  // 预置探测缓存，跳过 fetch HEAD 探测
  manager._probeCache = new Map([[VOICE_URL, true]]);
  // 直接注入运行中的假 AudioContext，跳过 createGraph
  manager.context = {
    state: 'running',
    currentTime: 0,
    createMediaElementSource: () => createFakeNode(),
    createGain: () => createFakeNode(),
    createStereoPanner: () => createFakeNode(),
    createBiquadFilter: () => createFakeNode(),
  };
  return manager;
}

const waitTick = () => new Promise(resolve => setTimeout(resolve, 5));

test('replace 播放不得被自己触发的 stopKind 作废，独白必须能真正起播', async () => {
  const manager = createTestManager();
  const pending = manager.playTrack('voice', { sources: [VOICE_URL] }, { loop: false, replace: true });
  await waitTick();

  assert.equal(manager.getState().kinds.voice, 'playing');

  const [element] = [...manager.tracks.keys()];
  element.dispatch('ended');

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.ended, true);
  assert.equal(manager.getState().kinds.voice, 'paused');
});

test('外部 stopKind 仍会打断正在播放的轨道', async () => {
  const manager = createTestManager();
  const pending = manager.playTrack('voice', { sources: [VOICE_URL] }, { loop: false, replace: true });
  await waitTick();
  assert.equal(manager.getState().kinds.voice, 'playing');

  manager.stopKind('voice');
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.interrupted, true);
  assert.equal(manager.getState().kinds.voice, 'paused');
});

test('循环环境声在起播后保持 playing 状态', async () => {
  const manager = createTestManager();
  const result = await manager.playTrack('ambience', { sources: [VOICE_URL] }, { loop: true, replace: true });
  assert.equal(result.ok, true);
  assert.equal(manager.getState().kinds.ambience, 'playing');
});
