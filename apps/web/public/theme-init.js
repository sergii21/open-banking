// Runs before the first paint (the page's policy allows scripts from this origin only, so it cannot be inline):
// applies the saved theme and the blurred-amounts choice so the page never flashes the wrong one.
(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem('ll.theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    if (localStorage.getItem('ll.private') === '1') root.setAttribute('data-private', '');
  } catch (e) {
    /* storage can be blocked; the defaults are fine */
  }
})();
