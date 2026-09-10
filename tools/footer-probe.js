(() => {
  const info = (el) => {
    if (el === null) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      cls: el.className === "" ? "" : String(el.className).slice(0, 120),
      data: Object.fromEntries([...el.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => [a.name, a.value])),
      text: (el.textContent ?? "").trim().slice(0, 80),
      box: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      display: style.display,
      flexDirection: style.flexDirection,
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      gap: style.gap,
      width: style.width,
      maxWidth: style.maxWidth,
      margin: style.margin,
      padding: style.padding,
      order: style.order,
      fontSize: style.fontSize,
      position: style.position,
      overflow: style.overflow
    };
  };
  const chain = (el, up = 6) => {
    const out = [];
    let node = el;
    for (let i = 0; node !== null && i < up; i++, node = node.parentElement) out.push(info(node));
    return out;
  };
  const row = document.querySelector("[data-composer-stats]");
  const scLine = document.querySelector(".sc_line");
  const scAny = document.querySelector('[class*="sc_"]');
  const statsPills = document.querySelectorAll("[data-composer-stats]").length;
  return {
    href: location.href,
    statsRows: statsPills,
    rowFound: row !== null,
    rowChildren: row === null ? [] : [...row.children].map(info),
    rowChain: row === null ? [] : chain(row, 4),
    pluginNodes: [...document.querySelectorAll('[class*="sc_"]')].map(info),
    scLineChain: scLine === null ? [] : chain(scLine, 3),
    scAnyFound: scAny !== null
  };
})()
