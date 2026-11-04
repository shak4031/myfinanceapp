(function () {
  const root = document.getElementById('knowledge-base-view');
  if (!root) return;

  const search = root.querySelector('#kb-search');
  const results = root.querySelector('#kb-results');
  const discovery = root.querySelector('.kb-discovery');
  const filters = [...root.querySelectorAll('[data-kb-filter]')];
  const sections = [...root.querySelectorAll('.kb-content > .kb-section')];
  const searchable = '.kb-card, .kb-feature, .kb-metric-list > div';
  let topic = 'all';

  const normalize = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  function apply() {
    const query = normalize(search.value);
    let visibleCount = 0;

    for (const section of sections) {
      const sectionMatches = topic === 'all' || section.dataset.kbTopic === topic;
      const articles = [...section.querySelectorAll(searchable)];
      let sectionCount = 0;

      for (const article of articles) {
        const matches = sectionMatches && (!query || normalize(article.textContent).includes(query));
        article.hidden = !matches;
        if (matches) {
          sectionCount++;
          visibleCount++;
        }
      }

      section.hidden = !sectionMatches || sectionCount === 0;
    }

    const filtered = topic !== 'all' || !!query;
    discovery.classList.toggle('is-filtering', filtered);
    results.textContent = filtered
      ? `${visibleCount} ${visibleCount === 1 ? 'guide' : 'guides'} found${query ? ` for “${search.value.trim()}”` : ''}.`
      : 'Choose a popular question or search all guides.';
    results.classList.toggle('is-empty', filtered && visibleCount === 0);
  }

  search.addEventListener('input', apply);
  filters.forEach(button => button.addEventListener('click', () => {
    topic = button.dataset.kbFilter;
    filters.forEach(filter => {
      const selected = filter === button;
      filter.classList.toggle('is-selected', selected);
      filter.setAttribute('aria-pressed', String(selected));
    });
    apply();
    if (topic !== 'all') root.querySelector(`[data-kb-topic="${topic}"]:not([hidden])`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  root.addEventListener('click', event => {
    const jump = event.target.closest('[data-kb-anchor]');
    if (!jump) return;
    const target = document.getElementById(jump.dataset.kbAnchor);
    if (!target) return;
    topic = 'all';
    search.value = '';
    filters.forEach(filter => {
      const selected = filter.dataset.kbFilter === 'all';
      filter.classList.toggle('is-selected', selected);
      filter.setAttribute('aria-pressed', String(selected));
    });
    apply();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (!root.classList.contains('active')) return;
    event.preventDefault();
    search.focus();
  });
  apply();
})();
