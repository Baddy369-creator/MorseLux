/* MorseLux offline helper: network first (so updates always win), after 3.5 s or without a network the saved copy,
   and for pages never opened before a small offline page */
var CACHE = "ml-6b33e2601e2026-11-12", CORE = ["/offline.html", "/assets/style.css", "/assets/morse.js", "/assets/tools.js", "/assets/icon-192.png", "/", "/de/", "/es/"];
self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return Promise.all(CORE.map(function (u) { return c.add(u).catch(function () {}); })); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  var saved = function () {
    return caches.match(r, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (r.mode === "navigate") return caches.match("/offline.html").then(function (o) { return o || Response.error(); });
      return Response.error();
    });
  };
  var net = fetch(r).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(r, copy); }); }
    return res;
  });
  var slow = new Promise(function (ok) { setTimeout(ok, 3500); }).then(function () {
    return caches.match(r, { ignoreSearch: true }).then(function (hit) { return hit || net; });
  });
  e.respondWith(Promise.race([net, slow]).catch(saved));
});
