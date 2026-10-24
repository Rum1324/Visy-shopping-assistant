(() => {
  const canvas = document.querySelector("#bg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w = 0;
  let h = 0;
  let t = 0;
  let dots = [];

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function waveY(x, layer, time) {
    const nx = x / w;
    return (
      h * 0.52 +
      Math.sin(nx * 2.4 + time * 0.55 + layer * 0.18) * (h * 0.11) +
      Math.sin(nx * 5.1 - time * 0.35 + layer * 0.4) * (h * 0.045) +
      layer * 7
    );
  }

  function seed() {
    dots = [];
    const count = Math.floor((w * h) / 2800);
    for (let i = 0; i < count; i++) {
      dots.push({
        x: Math.random() * w,
        along: Math.random(),
        layer: Math.random(),
        size: 0.6 + Math.random() * 1.8,
        drift: Math.random() * Math.PI * 2,
      });
    }
  }

  let hold = false;
  let offset = 0;
  let holdStart = 0;

  window.visyHold = (on) => {
    if (on && !hold) {
      hold = true;
      holdStart = performance.now();
      return;
    }
    if (!on && hold) {
      offset += performance.now() - holdStart;
      hold = false;
    }
  };

  function draw(time) {
    if (hold) {
      if (!reduce) requestAnimationFrame(draw);
      return;
    }
    t = (time - offset) / 1000;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const lines = 18;
    for (let i = lines; i >= 0; i--) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y = waveY(x, i, t);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const fade = 1 - i / lines;
      ctx.strokeStyle = `rgba(64, 168, 255, ${0.08 + fade * 0.22})`;
      ctx.lineWidth = i === 0 ? 1.6 : 0.7;
      ctx.stroke();
    }

    for (const d of dots) {
      const x = (d.x + Math.sin(t * 0.4 + d.drift) * 8 + w) % w;
      const y = waveY(x, d.layer * 14, t) - d.along * 36 - 8;
      const crest = 0.5 + 0.5 * Math.sin((x / w) * 2.4 + t * 0.55);
      const a = 0.15 + crest * 0.75 * (1 - d.along);
      ctx.beginPath();
      ctx.fillStyle = `rgba(90, 190, 255, ${a})`;
      ctx.arc(x, y, d.size * (0.7 + crest * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }

    const ridge = ctx.createLinearGradient(0, h * 0.3, 0, h * 0.7);
    ridge.addColorStop(0, "rgba(90, 200, 255, 0)");
    ridge.addColorStop(0.45, "rgba(60, 160, 255, 0.08)");
    ridge.addColorStop(1, "rgba(40, 120, 255, 0)");
    ctx.fillStyle = ridge;
    ctx.fillRect(0, 0, w, h);

    if (!reduce) requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(draw);
})();
