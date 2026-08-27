// 海洋3D交互冒烟测试：验证鼠标拖拽视角、下潜、垃圾投放三条路径
// 用法: 在浏览器控制台粘贴运行, 或配合 Playwright/puppeteer 使用
(function ocean3dSmokeTest() {
  const w = window.__oceanWorld;
  const results = {};
  const fail = (name, detail) => { results[name] = { ok: false, detail }; console.error('FAIL', name, detail); };
  const pass = (name, detail) => { results[name] = { ok: true, detail }; console.log('PASS', name, detail); };

  if (!w) return console.error('FAIL world-missing', '__oceanWorld 不存在');
  if (w.isGlobeVisible) return console.error('FAIL globe-mode', '请先从地球进入站点');

  // 1) 鼠标拖拽 → yaw/pitch 变化
  const canvas = document.querySelector('.ocean3d-canvas canvas');
  if (!canvas) return console.error('FAIL canvas-missing');
  const r = canvas.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const before = { yaw: w.fpYaw, pitch: w.fpPitch };
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, button: 0, pointerId: 101, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: cx + 80, clientY: cy - 40, pointerId: 101, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: cx + 80, clientY: cy - 40, pointerId: 101, bubbles: true }));
  const yawMoved = Math.abs(w.fpYaw - before.yaw) > 0.05;
  const pitchMoved = Math.abs(w.fpPitch - before.pitch) > 0.05;
  (yawMoved || pitchMoved) ? pass('mouse-drag', { yaw: before.yaw.toFixed(3) + '→' + w.fpYaw.toFixed(3), pitch: before.pitch.toFixed(3) + '→' + w.fpPitch.toFixed(3) })
    : fail('mouse-drag', { before, after: { yaw: w.fpYaw, pitch: w.fpPitch } });

  // 2) 下潜按钮/方法 → underwater=true, cameraY<0
  w.goUnderwater(-12);
  (w.isUnderwater && w.cameraY < -1) ? pass('dive', { cameraY: w.cameraY.toFixed(1), underwater: w.isUnderwater })
    : fail('dive', { cameraY: w.cameraY, underwater: w.isUnderwater });
  // 1s 后复查不回弹
  setTimeout(() => {
    w.isUnderwater ? pass('dive-stable', { cameraY: w.cameraY.toFixed(1) }) : fail('dive-stable', { cameraY: w.cameraY, underwater: w.isUnderwater });
    w.goToSurface();
  }, 1000);

  // 3) 垃圾投放: 模拟科普模式单击海面
  setTimeout(() => {
    const activeBefore = (w.getActiveGarbage() || []).length;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, button: 0, pointerId: 102, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, button: 0, pointerId: 102, bubbles: true }));
    setTimeout(() => {
      const activeAfter = (w.getActiveGarbage() || []).length;
      activeAfter > activeBefore ? pass('garbage-drop', { before: activeBefore, after: activeAfter })
        : fail('garbage-drop', { hint: '需处于科普模式', before: activeBefore, after: activeAfter });
      console.log('SUMMARY', JSON.stringify(results));
      const allOk = Object.values(results).every(v => v.ok);
      console[allOk ? 'log' : 'error'](allOk ? 'ALL PASS' : 'SOME FAILED');
    }, 300);
  }, 2200);
})();
