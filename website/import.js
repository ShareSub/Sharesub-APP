const parameters = new URLSearchParams(location.search);
const payload = parameters.get('url') || new URLSearchParams(location.hash.slice(1)).get('url') || '';
const launch = document.querySelector('#launch');
if (payload.length <= 16000 && /^(?:https?|vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(payload)) {
  launch.href = 'sharesub://import?' + new URLSearchParams({ url: payload });
  launch.hidden = false;
} else {
  document.querySelector('#import-message').textContent = 'В ссылке нет подписки или сервера для импорта.';
}
