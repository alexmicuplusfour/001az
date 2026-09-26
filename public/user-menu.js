// The user menu — the button in the top-right of every signed-in surface, and
// the rows behind it. One module because there are three surfaces and they had
// three copies: the gallery's toolbar, the boards page, and (as of
// planning/welcome-plan.md Stage 2) the welcome screen. The copies were
// identical down to the separator, and differed only in the two things below.
//
// It was extracted when Stage 3a wanted to add a row. That row has since been
// removed (see below), and the extraction is the part worth keeping: the next
// change to this menu is one edit rather than three.
//
// The two genuine differences, taken as arguments rather than sniffed:
//
//   me            the gallery holds it on `state`, the other two at module
//                 scope. Passing it also makes the admin-only rows a property
//                 of the READER rather than of which page is asking — the
//                 welcome screen used to omit that check, being admin-only
//                 anyway, which is the same answer by luck.
//   afterSignOut  the gallery reloads; the standalone pages go to login with
//                 their own `next`.
//
// `el` is for the gallery, whose toolbar is drawn by Preact: it draws the
// button empty and hands it here to be filled, once, so the button keeps its
// place in a row that redraws (planning/ui-updates-plan.md, D7). The boards
// and welcome pages leave it out and get a button built here.
import { openDropdown, ddRow, ddSep } from "./dropdown.js";
import { ICONS } from "./utils.js";

export function userMenuButton({ me, afterSignOut, el }) {
  let btn = el;
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "tool-btn user-menu-btn";
  }
  const name = document.createElement("span");
  name.className = "user-menu-name";
  name.textContent = me.name || me.email;
  const caret = document.createElement("span");
  caret.className = "dd-caret";
  caret.innerHTML = ICONS.chevron;
  btn.append(name, caret);
  btn.addEventListener("click", () => open(btn, me, afterSignOut));
  return btn;
}

function open(anchorEl, me, afterSignOut) {
  openDropdown(anchorEl, {
    className: "user-menu-pop",
    build: (body, { close }) => {
      // No "Setup" row. It was here for one release and it was wrong: /welcome
      // is a first-run guide, not a settings page, so a permanent link to it
      // reads as an unfinished task on an instance that has nothing left to do.
      // Changing a model later is Admin → Capabilities, which is what that page
      // is for and where the full vocabulary lives.
      //
      // The way BACK, for the admin who skipped or whose key died, is the
      // boards page's strip (welcome-plan.md 3b) — it appears exactly when
      // tagging isn't working and says what is wrong, which is the thing a
      // standing menu row could never do.
      if (me.is_admin) body.appendChild(ddRow({ label: "Admin", href: "/admin.html" }));
      body.appendChild(ddRow({ label: "Account", href: "/account.html" }));
      body.appendChild(ddSep());
      body.appendChild(ddRow({
        label: "Sign out",
        onClick: async () => {
          close();
          await fetch("/api/logout", { method: "POST" });
          afterSignOut();
        },
      }));
    },
  });
}
