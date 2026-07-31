/* 台股助手 Web Push service worker — 顯示 daemon 推送的警報通知 */
self.addEventListener('push', event => {
  let d = { title: '台股助手', body: '' };
  try { d = event.data.json(); } catch { d.body = event.data ? event.data.text() : ''; }
  event.waitUntil(self.registration.showNotification(d.title || '台股助手', {
    body: d.body || '',
    icon: '/globe.svg',
    badge: '/globe.svg',
    tag: d.tag || 'twstock-alert',
    data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
