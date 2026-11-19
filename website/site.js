const motion = matchMedia('(prefers-reduced-motion: no-preference)');
if (motion.matches && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('motion');
  const observer = new IntersectionObserver(items => {
    for (const item of items) {
      if (!item.isIntersecting) continue;
      item.target.classList.add('shown');
      observer.unobserve(item.target);
    }
  }, { threshold: .18 });
  for (const item of document.querySelectorAll('.reveal')) observer.observe(item);
}

try {
  const response = await fetch('/api/latest.json', { signal: AbortSignal.timeout(4000) });
  if (response.ok) {
    const { payload } = await response.json();
    const { version } = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), char => char.charCodeAt(0))));
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      const latest = document.querySelector('#latest');
      latest.textContent = 'Версия ' + version;
      latest.hidden = false;
    }
  }
} catch { /* download links work independently */ }
