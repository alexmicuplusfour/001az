// The left-rail tab switcher the two standalone member pages share
// (admin.html and account.html). Extracted when the account page grew a second
// tab (planning/mcp-members-plan.md §10.11) — the markup and the CSS were
// already shared through panel.css, and this was the last piece each page was
// going to write for itself.
//
// WHAT IS NOT IN HERE is the point. The admin shell's switcher carried three
// things that are that page's, not tabs-in-general: the logs SSE stream
// following visibility, Storage re-rendering on every select, and the default
// tab normalising to the bare path instead of a hash. Lifting the function
// whole would have carried a logs stream into a page with no logs, so those
// arrive as `onSelect` and `defaultTab` and the switcher stays about tabs.
//
// `.tab-link` is deliberately NOT `.tab`: panel.css says so, and the pages wire
// clicks on every `.tab` as a panel switch — the Gallery back-link is a
// look-alike that navigates.

// `names` is the vocabulary: a hash naming anything else is ignored rather than
// blanking the page. `defaultTab` is the one whose hash is dropped from the URL
// (nobody deep-links "the page as it opens"). `onSelect` runs after the switch,
// for whatever that page hangs off visibility.
export function mountTabs({ names, defaultTab = names[0], onSelect = () => {} } = {}) {
  const tabBtns = [...document.querySelectorAll(".tab")];

  function selectTab(name) {
    tabBtns.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "panel-" + name));
    // A deep-link suffix (#capabilities/tag) survives selection; anything else
    // normalizes to the bare tab hash.
    const keep = location.hash.startsWith("#" + name + "/") ? location.hash : "#" + name;
    history.replaceState(null, "", name === defaultTab ? location.pathname : keep);
    onSelect(name);
  }

  tabBtns.forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
  // The tab is the hash's FIRST segment — in-page links (the Plugins tab's
  // "default tagger" badges → #capabilities/tag) switch tabs through this.
  const fromHash = () => location.hash.slice(1).split("/")[0];
  if (names.includes(fromHash())) selectTab(fromHash());
  addEventListener("hashchange", () => { if (names.includes(fromHash())) selectTab(fromHash()); });

  return { selectTab };
}
