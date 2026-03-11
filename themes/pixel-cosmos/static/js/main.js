// Stars background
(function () {
  const container = document.getElementById('stars');
  if (!container) return;
  const count = 80;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.style.cssText = [
      `left:${Math.random() * 100}%`,
      `top:${Math.random() * 100}%`,
      `--dur:${2 + Math.random() * 4}s`,
      `--delay:${Math.random() * 5}s`,
      `--op:${0.3 + Math.random() * 0.6}`,
      `width:${Math.random() > .8 ? 3 : 2}px`,
      `height:${Math.random() > .8 ? 3 : 2}px`,
    ].join(';');
    frag.appendChild(s);
  }
  container.appendChild(frag);
})();

// Mobile nav toggle
(function () {
  const toggle = document.querySelector('.nav-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    document.body.classList.toggle('nav-open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.site-header')) {
      document.body.classList.remove('nav-open');
    }
  });
})();

// Add copy button to code blocks
(function () {
  document.querySelectorAll('.article-body pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.textContent = 'copy';
    btn.className = 'copy-btn';
    btn.style.cssText = 'position:absolute;top:10px;right:10px;font-size:10px;padding:4px 10px;background:rgba(138,90,255,.25);color:#c0b8e0;border:1px solid rgba(138,90,255,.4);border-radius:4px;cursor:pointer;';
    pre.style.position = 'relative';
    pre.appendChild(btn);
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
      btn.textContent = 'copied!';
      btn.style.color = '#40c8ff';
      setTimeout(() => { btn.textContent = 'copy'; btn.style.color = '#c0b8e0'; }, 2000);
    });
  });
})();
