// Shared delight helpers: confetti + count-up. Respect prefers-reduced-motion.
const UI = (() => {
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function confetti(count = 120) {
    if (calm()) return;
    const c = document.createElement("canvas"); c.id = "ui-confetti";
    c.width = innerWidth; c.height = innerHeight; document.body.appendChild(c);
    const g = c.getContext("2d"), cols = ["#5b4ee8", "#9b7bff", "#12a06a", "#f5a623", "#ff7aa8"];
    const ps = Array.from({ length: count }, () => ({
      x: innerWidth / 2, y: innerHeight * 0.4, r: 4 + Math.random() * 5, col: cols[(Math.random() * cols.length) | 0],
      vx: (Math.random() - 0.5) * 16, vy: -6 - Math.random() * 11, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4
    }));
    let t = 0;
    (function frame() {
      g.clearRect(0, 0, c.width, c.height); t++;
      ps.forEach((p) => { p.vy += 0.28; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.globalAlpha = Math.max(0, 1 - t / 150);
        g.fillStyle = p.col; g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); g.restore(); });
      t < 150 ? requestAnimationFrame(frame) : c.remove();
    })();
  }
  function countUp(el, to, ms = 1100) {
    if (calm()) { el.textContent = to + "%"; return; }
    const t0 = performance.now();
    (function tick(now) {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(to * e) + "%";
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }
  function toast(msg, ms = 3200) {
    const t = document.createElement("div"); t.className = "ui-toast"; t.textContent = msg; t.setAttribute("role", "status");
    document.body.appendChild(t); setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, ms);
  }
  return { confetti, countUp, toast };
})();

// Eye-reveal for every password field (and any input marked data-secret).
document.addEventListener("DOMContentLoaded", () => {
  const eye = '<svg class="on" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="off" viewBox="0 0 24 24"><path d="M17.94 17.94A10.9 10.9 0 0112 19C5 19 1 12 1 12a18.5 18.5 0 015.06-5.94M9.9 4.24A10.9 10.9 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22"/></svg>';
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    const wrap = document.createElement("div"); wrap.className = "pw-wrap";
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const b = document.createElement("button"); b.type = "button"; b.className = "pw-eye";
    b.setAttribute("aria-label", "Show password"); b.setAttribute("aria-pressed", "false"); b.innerHTML = eye;
    b.addEventListener("click", () => {
      const show = input.type === "password"; input.type = show ? "text" : "password";
      b.setAttribute("aria-pressed", show); b.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
    wrap.appendChild(b);
  });
});
