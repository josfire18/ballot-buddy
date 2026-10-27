// Light/dark toggle. Loaded as a classic script in <head> so the saved theme
// applies before first paint (no flash). With nothing saved, the page follows
// the device setting through the prefers-color-scheme rules in styles.css.
(function () {
  var KEY = "ballot-buddy-theme";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try { var t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : null; } catch (e) { return null; }
  }
  function current() {
    return saved() || (media && media.matches ? "dark" : "light");
  }
  function apply(theme) {
    if (theme) root.setAttribute("data-theme", theme); else root.removeAttribute("data-theme");
  }
  function label(btn) {
    var dark = current() === "dark";
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.setAttribute("data-mode", dark ? "dark" : "light");
  }

  apply(saved());

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    label(btn);
    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
      label(btn);
    });
    if (media && media.addEventListener) {
      media.addEventListener("change", function () { if (!saved()) label(btn); });
    }
  });
})();
