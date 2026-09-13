// The user menu — the button in the top-right of every signed-in surface, and
// the rows behind it. One module because there are three surfaces and they had
// three copies: the gallery's toolbar, the boards page, and (as of
// planning/welcome-plan.md Stage 2) the welcome screen. The copies were
// identical down to the separator, and differed only in the two things below.
//
// It was extracted when Stage 3a wanted to add a row: adding it three times is
// how the copies got to three in the first place.
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
import { openDropdown, ddRow, ddSep } from "./dropdown.js";
import { ICONS } from "./utils.js";

export function userMenuButton({ me, afterSignOut }) {
  const btn = document.createElement("button");
  btn.className = "tool-btn user-menu-btn";
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
      if (me.is_admin) {
        // The answer to "how do they get back" (welcome-plan.md Stage 3a).
        // Always present and carrying no state: a row that shows up only when
        // something is wrong is a row nobody can find when something is wrong,
        // and the badge it would wear costs a capability feed per menu open.
        // Above Admin because it is the smaller door — one decision, versus
        // every setting this instance has.
        body.appendChild(ddRow({ label: "Setup", href: "/welcome" }));
        body.appendChild(ddRow({ label: "Admin", href: "/admin.html" }));
      }
      body.appendChild(ddRow({ label: "Profile", href: "/profile.html" }));
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
