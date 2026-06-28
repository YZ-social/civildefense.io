const track    = document.getElementById('carouselTrack');
const slides   = track.querySelectorAll('.carousel-slide');
const dotsWrap = document.getElementById('carouselDots');
const prevBtn  = document.getElementById('prevBtn');
const nextBtn  = document.getElementById('nextBtn');
let current = 0;
let autoTimer;

// Build dots
slides.forEach((_, i) => {
  const btn = document.createElement('button');
  btn.className = 'dot' + (i === 0 ? ' active' : '');
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-label', ariaSlideLabel + (i + 1));
  btn.addEventListener('click', () => goTo(i));
  dotsWrap.appendChild(btn);
});

function goTo(idx) {
  current = (idx + slides.length) % slides.length;
  track.style.transform = `translateX(-${current * 100}%)`;
  dotsWrap.querySelectorAll('.dot').forEach((d, i) => {
    d.classList.toggle('active', i === current);
  });
  resetAuto();
}

prevBtn.addEventListener('click', () => goTo(current - 1));
nextBtn.addEventListener('click', () => goTo(current + 1));

// Touch / swipe
let startX = null;
track.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
track.addEventListener('touchend', e => {
  if (startX === null) return;
  const dx = e.changedTouches[0].clientX - startX;
  if (Math.abs(dx) > 40) goTo(dx < 0 ? current + 1 : current - 1);
  startX = null;
}, { passive: true });

// Pause on hover/focus
const wrap = document.querySelector('.carousel-track-outer');
wrap.addEventListener('mouseenter', stopAuto);
wrap.addEventListener('mouseleave', resetAuto);

// Auto-advance every few seconds
function advance() {
  goTo(current + 1);
}
function resetAuto() {
  if (navigator.userAgentData?.mobile || navigator.maxTouchPoints > 0 || window.matchMedia("(max-width: 768px)").matches) return; // Do not auto-advance on mobile.
  const video = document.querySelector('video');
  if (video.currentTime > 0 && !video.paused && !video.ended && video.readyState > 2) return;
  if (wrap.matches(':hover')) return;
  clearInterval(autoTimer);
  autoTimer = setInterval(advance, 10e3);
}
function stopAuto() {
  clearInterval(autoTimer);
}
resetAuto();
document.querySelectorAll('video').forEach(video => {
  video.addEventListener('play', stopAuto);
  video.addEventListener('ended', () => {
    advance();
    resetAuto();
  });
});

