(() => {
  const cleanDanglingMarkers = () => {
    document.querySelectorAll('.settings-row').forEach((row) => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const remove = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim() === '>') remove.push(node);
      }
      remove.forEach((item) => item.remove());
    });
  };

  let queued = false;
  const scheduleCleanup = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      cleanDanglingMarkers();
    });
  };

  cleanDanglingMarkers();
  new MutationObserver(scheduleCleanup).observe(document.body, { childList: true, subtree: true });
})();
