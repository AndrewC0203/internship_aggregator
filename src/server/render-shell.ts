import { css } from "./render.js";

// Shared shell for the non-board pages (/profile, /tryout): same head, same tape header,
// same stylesheet as the board — one world (DESIGN.md), the sub-pages only add content
// styles. Kept apart from render.ts because the board page owns search-specific chrome
// (ticker, NEW block) these pages deliberately don't repeat. /foryou retired (Decision 34
// addendum) — ranking lives on the board itself now.

export function subPage(args: {
  title: string;
  active: "profile" | "tryout";
  body: string;
  extraCss?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${args.title}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%23050507'/><rect x='5' y='5' width='6' height='6' fill='%234D9FFF'/></svg>`)}">
<style>${css()}
/* sub-page shared chrome */
.sub{max-width:1040px;margin:0 auto;padding:22px}
.sub h2{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.18em;color:var(--ink-2);margin:26px 0 10px}
.sub h2:first-child{margin-top:0}
.panel{background:var(--bg1);border:1px solid var(--line);padding:16px}
.note{font-size:12px;color:var(--ink-3);margin:8px 0}
${args.extraCss ?? ""}</style>
</head>
<body>
<header class="tape">
  <div class="brand">
    <h1><a href="/" style="color:inherit;text-decoration:none">CS OPPORTUNITIES</a></h1>
    <span class="brand-sub">EARLY-CAREER BOARD</span>
  </div>
  <nav class="views" aria-label="views" style="margin-left:auto">
    <a href="/profile"${args.active === "profile" ? ` aria-current="page"` : ""}>PROFILE</a>
    <a href="/tryout"${args.active === "tryout" ? ` aria-current="page"` : ""}>TRYOUT</a>
  </nav>
</header>
<main class="sub">
${args.body}
</main>
</body>
</html>`;
}
