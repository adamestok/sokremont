
document.addEventListener('DOMContentLoaded', function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- ТЕМА ---------- */
  var html = document.documentElement;
  var themeBtn = $('#themeBtn');
  function applyTheme(t) {
    html.setAttribute('data-theme', t);
    var i = themeBtn.querySelector('i');
    var tip = themeBtn.querySelector('.tip');
    i.className = t === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    tip.textContent = t === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    var m = $('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#0D1B2A' : '#FFFFFF');
  }
  var saved = null;
  try { saved = localStorage.getItem('sok-theme'); } catch (e) {}
  applyTheme(saved === 'light' ? 'light' : 'dark');
  themeBtn.addEventListener('click', function () {
    var next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('sok-theme', next); } catch (e) {}
  });

  /* ---------- LENIS ---------- */
  var lenis = null;
  if (typeof Lenis !== 'undefined' && !reduce) {
    lenis = new Lenis({ lerp: 0.08 });
    var raf = function (time) { lenis.raf(time); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    $$('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var id = a.getAttribute('href');
        if (id.length < 2) return;
        var t = document.querySelector(id);
        if (!t) return;
        e.preventDefault();
        lenis.scrollTo(t, { offset: -70 });
        closeMob();
      });
    });
  }

  /* ---------- AOS ---------- */
  if (typeof AOS !== 'undefined') AOS.init({ duration: 700, once: true, offset: 80, disable: reduce });

  /* ---------- ПРОГРЕСС-БАР + ХЕДЕР ---------- */
  var bar = $('#progress'), hdr = $('#hdr');
  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    var max = document.body.scrollHeight - window.innerHeight;
    bar.style.width = (max > 0 ? (y / max) * 100 : 0) + '%';
    hdr.classList.toggle('on', y > 80);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- МОБИЛЬНОЕ МЕНЮ ---------- */
  var burger = $('#burger'), mob = $('#mob');
  function closeMob() {
    mob.classList.remove('open');
    burger.classList.remove('x');
    burger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
  burger.addEventListener('click', function () {
    var open = mob.classList.toggle('open');
    burger.classList.toggle('x', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.style.overflow = open ? 'hidden' : '';
  });
  $$('#mob a').forEach(function (a) { a.addEventListener('click', closeMob); });

  /* ---------- HERO: SPLITTING + GSAP ---------- */
  var h1 = $('#hero h1');
  if (typeof Splitting !== 'undefined' && typeof gsap !== 'undefined' && !reduce) {
    Splitting({ target: h1, by: 'words' });
    gsap.from(h1.querySelectorAll('.word'), { yPercent: 110, opacity: 0, duration: 0.9, stagger: 0.08, ease: 'power3.out' });
    gsap.to('#heroSub', { opacity: 1, y: 0, duration: 0.8, delay: 0.3, ease: 'power2.out', startAt: { y: 18 } });
  } else {
    $('#heroSub').style.opacity = 1;
  }

  /* ---------- tsParticles ---------- */
  if (typeof tsParticles !== 'undefined' && !reduce) {
    tsParticles.load('particles', {
      fpsLimit: 60,
      particles: {
        number: { value: 28 },
        color: { value: '#ffffff' },
        opacity: { value: 0.18 },
        size: { value: 2 },
        move: { enable: true, direction: 'top', speed: 0.5, outModes: { default: 'out' } },
        links: { enable: false }
      },
      interactivity: { events: { onHover: { enable: false }, onClick: { enable: false } } },
      detectRetina: true
    });
  }

  /* ---------- ПАРАЛЛАКС ОТ МЫШИ ---------- */
  var hero = $('#hero');
  if (window.matchMedia('(min-width: 1024px)').matches && !reduce) {
    hero.addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect();
      var x = (e.clientX - r.width / 2) / r.width;
      var y = (e.clientY - r.height / 2) / r.height;
      hero.style.setProperty('--px', (-x * 2.5) + '%');
      hero.style.setProperty('--py', (-y * 2) + '%');
      var copy = $('.hero-copy');
      copy.style.transform = 'translate(' + (x * 12) + 'px,' + (y * 8) + 'px)';
      var vis = $('.hero-visual');
      if (vis) vis.style.transform = 'translate(' + (-x * 16) + 'px,' + (-y * 10) + 'px)';
    });
    hero.addEventListener('mouseleave', function () {
      $('.hero-copy').style.transform = '';
      var vis = $('.hero-visual');
      if (vis) vis.style.transform = '';
    });
  }

  /* ---------- АВТО-ГОДЫ В СТРОИТЕЛЬСТВЕ (с 2010) ---------- */
  var yearsNum = new Date().getFullYear() - 2010;
  $$('.js-years').forEach(function (el) {
    if (el.dataset.target) el.dataset.target = yearsNum;
    else el.textContent = yearsNum;
  });

  /* ---------- СЧЕТЧИКИ ---------- */
  var counters = $$('#stats .num');
  var fmt = function (v, d) {
    return d ? v.toFixed(d).replace('.', ',') : Math.round(v).toLocaleString('ru-RU');
  };
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target;
      io.unobserve(el);
      var target = parseFloat(el.dataset.target);
      var dec = parseInt(el.dataset.decimals || '0', 10);
      var pre = el.dataset.prefix || '';
      var suf = el.dataset.suffix || '';
      if (typeof gsap === 'undefined' || reduce) {
        el.textContent = pre + fmt(target, dec) + suf;
        el.classList.add('done');
        return;
      }
      var obj = { v: 0 };
      gsap.to(obj, {
        v: target, duration: 2, ease: 'expo.out',
        onUpdate: function () { el.textContent = pre + fmt(obj.v, dec) + suf; },
        onComplete: function () {
          el.textContent = pre + fmt(target, dec) + suf;
          el.classList.add('done');
        }
      });
    });
  }, { threshold: 0.4 });
  counters.forEach(function (c) { io.observe(c); });

  /* ---------- VANILLA TILT (откл. на мобилке) ---------- */
  function tilt() {
    var cards = $$('[data-tilt]');
    var mobile = window.innerWidth < 768 || reduce;
    cards.forEach(function (c) {
      if (mobile) {
        if (c.vanillaTilt) c.vanillaTilt.destroy();
      } else if (!c.vanillaTilt && typeof VanillaTilt !== 'undefined') {
        VanillaTilt.init(c, { max: 6, speed: 400, glare: true, 'max-glare': 0.12 });
      }
    });
  }
  tilt();
  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(tilt, 200); });

  /* ---------- SWIPER ---------- */
  if (typeof Swiper !== 'undefined') {
    new Swiper('.testimonials-swiper', {
      loop: true,
      spaceBetween: 24,
      grabCursor: true,
      centeredSlides: true,
      autoplay: { delay: 3500, disableOnInteraction: false, pauseOnMouseEnter: true },
      pagination: { el: '.swiper-pagination', clickable: true },
      breakpoints: {
        0: { slidesPerView: 1.15, centeredSlides: true },
        768: { slidesPerView: 2.2, centeredSlides: false },
        1024: { slidesPerView: 3, centeredSlides: false }
      }
    });
  }

  /* ---------- FAQ ---------- */
  $$('.faq-item').forEach(function (item) {
    var q = $('.faq-q', item), a = $('.faq-a', item);
    q.addEventListener('click', function () {
      var open = item.classList.contains('open');
      $$('.faq-item.open').forEach(function (o) {
        o.classList.remove('open');
        $('.faq-a', o).style.maxHeight = '0px';
        $('.faq-q', o).setAttribute('aria-expanded', 'false');
      });
      if (!open) {
        item.classList.add('open');
        a.style.maxHeight = a.scrollHeight + 'px';
        q.setAttribute('aria-expanded', 'true');
      }
    });
  });

  /* ---------- ТАЙМЕР 2 ЧАСА ---------- */
  var tEl = $('#timer'), TOTAL = 2 * 60 * 60 * 1000, deadline = Date.now() + TOTAL;
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  setInterval(function () {
    var left = deadline - Date.now();
    if (left <= 0) { deadline = Date.now() + TOTAL; left = TOTAL; }
    var s = Math.floor(left / 1000);
    tEl.textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }, 1000);

  /* ---------- ВИДЕО (VK facade / локальный файл в модалке) ---------- */
  var vlb = $('#vidLb'), vvid = $('#vidLbVideo');
  function openVid(src, poster){
    vvid.src = src;
    vvid.poster = poster || '';
    vlb.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (lenis) lenis.stop();
    vvid.play().catch(function(){});
  }
  function closeVid(){
    if (!vlb.classList.contains('open')) return;
    vlb.classList.remove('open');
    vvid.pause();
    vvid.removeAttribute('src');
    vvid.load();
    document.body.style.overflow = '';
    if (lenis) lenis.start();
  }
  $('#vidLbClose').addEventListener('click', closeVid);
  vlb.addEventListener('click', function (e) { if (e.target === vlb) closeVid(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeVid(); });

  $$('.vid').forEach(function (v) {
    v.addEventListener('click', function () {
      if (v.querySelector('iframe')) return;
      if (v.dataset.src) {
        var im = v.querySelector('img');
        openVid(v.dataset.src, im ? im.src : '');
        return;
      }
      var f = document.createElement('iframe');
      f.src = 'https://vk.com/video_ext.php?oid=' + v.dataset.oid + '&id=' + v.dataset.id + '&hd=2&autoplay=1';
      f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
      f.setAttribute('allowfullscreen', 'true');
      v.appendChild(f);
      var p = v.querySelector('.vid-play');
      if (p) p.style.display = 'none';
    });
  });

  /* ---------- ЛАЙТБОКС ---------- */
  var lb = $('#lb'), lbImg = $('#lbImg'), lbCap = $('#lbCap');
  $$('.gal figure').forEach(function (f) {
    f.addEventListener('click', function () {
      lbImg.src = f.dataset.src;
      lbImg.alt = $('img', f).alt;
      lbCap.textContent = $('figcaption', f).textContent;
      lb.classList.add('open');
      document.body.style.overflow = 'hidden';
      if (lenis) lenis.stop();
    });
  });
  function closeLb() {
    lb.classList.remove('open');
    document.body.style.overflow = '';
    if (lenis) lenis.start();
  }
  $('#lbClose').addEventListener('click', closeLb);
  lb.addEventListener('click', function (e) { if (e.target === lb) closeLb(); });

  /* ---------- ПОЛИТИКА ---------- */
  var pol = $('#policy');
  function closePol() {
    pol.classList.remove('open');
    document.body.style.overflow = '';
    if (lenis) lenis.start();
  }
  $('#policyOpen').addEventListener('click', function () {
    pol.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (lenis) lenis.stop();
  });
  $('#policyClose').addEventListener('click', closePol);
  pol.addEventListener('click', function (e) { if (e.target === pol) closePol(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeLb(); closePol(); closeMob(); }
  });
});
