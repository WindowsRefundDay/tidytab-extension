(() => {
  window.__aiTabSorterExtract = (maxLength = 1200) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };

    const metaDescription = clean(document.querySelector('meta[name="description"]')?.content);
    const headings = [...document.querySelectorAll("h1, h2, h3")]
      .filter(isVisible)
      .map((node) => clean(node.textContent))
      .filter(Boolean)
      .slice(0, 12);

    const blocked = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "IFRAME"]);
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || blocked.has(parent.tagName) || !isVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        return clean(node.nodeValue).length > 20 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    const bodyParts = [];
    let textLength = 0;
    while (walker.nextNode() && textLength < maxLength) {
      const text = clean(walker.currentNode.nodeValue);
      bodyParts.push(text);
      textLength += text.length + 1;
    }

    const sections = [
      clean(document.title),
      metaDescription && `Description: ${metaDescription}`,
      headings.length && `Headings: ${headings.join(" | ")}`,
      bodyParts.length && `Text: ${bodyParts.join(" ")}`
    ].filter(Boolean);

    return clean(sections.join("\n")).slice(0, maxLength);
  };
})();
