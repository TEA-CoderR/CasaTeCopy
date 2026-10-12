// Viscio：只采集和我们产品库对得上的商品图片
// 用法：在你自己已登录的 Chrome 里打开 Viscio 门户，按 F12 → Console（控制台），把这整段粘贴进去回车。
// 它向本机产品库程序要"还缺图片的、对得上的 Viscio 商品"清单（已按你设的采集优先级过滤），
// 然后慢慢地一张一张下载这些商品的图片交给产品库保存。门户拒绝访问时会自动放慢；连续被拒会自己停下。
// 账号和令牌不会离开这个浏览器。随时可以关掉页面停止，再运行一次会接着下载。
(async () => {
  const LOCAL = 'http://localhost:3000/api/catalog/supplier-catalog/viscio';
  const API = 'https://www.visciotrading.it/api/vas.svc/secure/';
  const st = (window.__casaCopy = { phase: 'token', todo: 0, done: 0, errors: 0, refused: 0, pause: 3000, stop: false, last: '' });
  const log = (...a) => console.log('%c[Viscio 采集]', 'color:#059669;font-weight:bold', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // the portal's own access token, taken from its next request
  if (!window.__casaHooked) {
    window.__casaHooked = true;
    window.__casaHdr = window.__casaHdr || {};
    const oOpen = XMLHttpRequest.prototype.open, oSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (String(this.__u).includes('vas.svc') && k === 'Token') window.__casaHdr.Token = v; return oSet.apply(this, arguments); };
  }
  for (let i = 0; !(window.__casaHdr && window.__casaHdr.Token); i++) {
    if (i % 10 === 0) log('等待门户的登录令牌：请在页面上点开一个分类或往下滚动一下…');
    await sleep(1000);
  }
  const H = () => ({ Token: window.__casaHdr.Token });

  const list = await fetch(LOCAL + '/todo').then((r) => r.json()).catch(() => null);
  if (!list) { log('连不上本机的产品库程序。请先打开「产品库.bat」，并允许 Chrome 访问本地网络。'); st.phase = 'no-local'; return; }
  const jobs = list.todo;
  st.todo = jobs.length;
  st.phase = 'photos';
  log(`对得上的 Viscio 商品 ${list.items} 个（按优先级跳过 ${list.skippedByPriority} 个），还要下载 ${jobs.length} 张图`);

  let refusedInRow = 0, okInRow = 0;
  while (!st.stop && jobs.length) {
    const j = jobs[0];
    try {
      const r = await fetch(API + 'GetFoto/' + encodeURIComponent(j.name), { headers: H() });
      if (r.status === 403 || r.status === 429 || r.status === 503) {
        st.refused++; refusedInRow++; okInRow = 0;
        st.pause = Math.min(60000, Math.round(st.pause * 1.6));
        if (refusedInRow >= 8) { st.stop = true; log('门户连续拒绝访问，已停止。过几个小时或明天再运行一次会接着下载。'); break; }
        log(`门户暂时拒绝（${r.status}），放慢到每 ${Math.round(st.pause / 1000)} 秒一张，等一会儿再试`);
        await sleep(Math.max(30000, st.pause));
        continue;
      }
      refusedInRow = 0;
      jobs.shift();
      if (r.ok) {
        const blob = await r.blob();
        if (blob.size > 200) {
          const sv = await fetch(`${LOCAL}/image?key=${encodeURIComponent(j.key)}&idx=${j.idx}&src=${encodeURIComponent('GetFoto/' + j.name)}`, { method: 'POST', body: blob });
          if (sv.ok) st.done++; else st.errors++;
        } else st.errors++;
      } else st.errors++;
      st.last = j.name;
      if (++okInRow >= 40 && st.pause > 1500) { okInRow = 0; st.pause = Math.round(st.pause * 0.85); }
      if (st.done % 50 === 0 && st.done) log(`已下载 ${st.done} / ${st.todo}`);
    } catch (e) {
      st.errors++;
      await sleep(5000);
    }
    await sleep(st.pause);
  }
  st.phase = st.stop ? 'stopped' : 'done';
  log(`结束：下载了 ${st.done} 张，出错 ${st.errors} 次，被拒 ${st.refused} 次。回到产品库，在 Viscio 那一行点「和产品库比对」。`);
})();
