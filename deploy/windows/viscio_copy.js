// Viscio 目录复制脚本 —— 在你自己已登录的 Chrome 里、Viscio 门户页面的控制台(F12 → Console)粘贴运行。
// 它用门户自己的接口读取全部商品(所有字段)和每个商品的全部图片，交给本机正在运行的产品库程序保存。
// 账号、密码、令牌都不会离开这个浏览器；程序只收到商品数据和图片。
// 运行中可以随时关闭页面停止；再运行一次会跳过已经保存的图片，接着复制。
(async () => {
  const LOCAL = 'http://localhost:3000/api/catalog/supplier-catalog/viscio';
  const API = 'https://www.visciotrading.it/api/vas.svc/secure/';
  const PAGE = 500; // articles per request
  const PARALLEL = 2; // photos downloaded at the same time (kept low on purpose)
  const PAUSE_MS = 150; // pause between photos per worker
  const st = (window.__casaCopy = { phase: 'start', items: 0, photosTotal: 0, photosDone: 0, photosSkipped: 0, errors: 0, last: '', stop: false });
  const log = (...a) => console.log('%c[Viscio 复制]', 'color:#2563eb;font-weight:bold', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) the portal's own access token: taken from the portal's next request (scroll the page once if it waits)
  if (!window.__casaHooked) {
    window.__casaHooked = true;
    window.__casaHdr = window.__casaHdr || {};
    const oOpen = XMLHttpRequest.prototype.open, oSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (String(this.__u).includes('vas.svc') && k === 'Token') window.__casaHdr.Token = v; return oSet.apply(this, arguments); };
  }
  st.phase = 'token';
  for (let i = 0; !window.__casaHdr.Token; i++) {
    if (i % 10 === 0) log('等待门户的登录令牌：请在页面上随便点开一个分类或往下滚动一下…');
    await sleep(1000);
  }
  const H = () => ({ Token: window.__casaHdr.Token });
  const ping = await fetch(LOCAL + '/have').catch(() => null);
  if (!ping || !ping.ok) {
    log('连不上本机的产品库程序（' + LOCAL + '）。请先双击「产品库.bat」，并在 Chrome 询问"访问本地网络设备"时点允许。');
    st.phase = 'no-local';
    return;
  }

  // 2) all articles, every field
  st.phase = 'items';
  const items = [];
  for (let skip = 0; ; skip += PAGE) {
    let page = null;
    for (let t = 0; t < 4 && !page; t++) {
      const r = await fetch(`${API}GetArticoliNew/Salta=${skip}Prendi=${PAGE}`, { headers: H() }).catch(() => null);
      if (r && r.ok) page = await r.json();
      else { st.errors++; await sleep(5000 * (t + 1)); }
    }
    if (!page) { log('读取商品列表失败，稍后再运行一次即可接着复制'); st.phase = 'failed'; return; }
    items.push(...page);
    const sv = await fetch(LOCAL + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: page }) });
    if (!sv.ok) { log('保存商品失败：' + (await sv.text())); st.phase = 'failed'; return; }
    st.items = items.length;
    log(`商品 ${items.length} 个`);
    if (page.length < PAGE) break;
    await sleep(800);
  }

  // 3) every photo of every article: GetFoto/<code>, GetFoto/<code>_1, _2, …
  st.phase = 'photos';
  const have = new Set((await fetch(LOCAL + '/have').then((r) => r.json())).images);
  const jobs = [];
  for (const a of items) {
    const n = Math.max(0, Number(a.NumeroFoto) || 0);
    for (let i = 0; i < n; i++) {
      if (have.has(`${a.No_}/${i + 1}`)) { st.photosSkipped++; continue; }
      jobs.push({ key: a.No_, idx: i + 1, name: i === 0 ? a.No_ : `${a.No_}_${i}` });
    }
  }
  st.photosTotal = jobs.length;
  log(`要下载的图片 ${jobs.length} 张（已有 ${st.photosSkipped} 张跳过）`);
  let forbidden = 0;
  const worker = async () => {
    while (!st.stop && jobs.length) {
      const j = jobs.shift();
      try {
        const r = await fetch(API + 'GetFoto/' + encodeURIComponent(j.name), { headers: H() });
        if (r.status === 403 || r.status === 429) {
          forbidden++;
          st.errors++;
          if (forbidden >= 5) { st.stop = true; log('门户连续拒绝访问，已停止。过一段时间再运行一次会接着复制。'); break; }
          await sleep(30000);
          jobs.unshift(j); // try this one again
          continue;
        }
        forbidden = 0;
        if (!r.ok) { st.errors++; continue; }
        const blob = await r.blob();
        if (blob.size < 200) { st.errors++; continue; }
        const sv = await fetch(`${LOCAL}/image?key=${encodeURIComponent(j.key)}&idx=${j.idx}&src=${encodeURIComponent('GetFoto/' + j.name)}`, { method: 'POST', body: blob });
        if (sv.ok) st.photosDone++; else st.errors++;
        st.last = j.name;
        if (st.photosDone % 200 === 0) log(`图片 ${st.photosDone} / ${st.photosTotal}`);
      } catch (e) {
        st.errors++;
        await sleep(2000);
      }
      await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  st.phase = st.stop ? 'stopped' : 'done';
  log(`完成：商品 ${st.items} 个，新下载图片 ${st.photosDone} 张，跳过 ${st.photosSkipped} 张，出错 ${st.errors} 次。回到产品库点「和产品库比对」。`);
})();
