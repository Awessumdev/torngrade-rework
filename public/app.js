const data = [
  {
    category: 'Politics',
    title: 'Trump Speech',
    startsAt: 'Today 21:00',
    markets: [
      {
        id: 'mkt-trump-yes',
        question: 'Will Trump say "yes"?',
        source: 'Official transcript',
        outcomes: [
          { id: 'out-yes', name: 'YES', odds: 1.7 },
          { id: 'out-no', name: 'NO', odds: 2.05 },
        ],
      },
      {
        id: 'mkt-trump-economy',
        question: 'Will he mention inflation?',
        source: 'Speech transcript',
        outcomes: [
          { id: 'out-inflation-yes', name: 'YES', odds: 1.55 },
          { id: 'out-inflation-no', name: 'NO', odds: 2.35 },
        ],
      },
    ],
  },
  {
    category: 'Sports',
    title: 'Istanbul Derby',
    startsAt: 'Tomorrow 20:30',
    markets: [
      {
        id: 'mkt-derby-goals',
        question: 'Over 2.5 goals?',
        source: 'Final score',
        outcomes: [
          { id: 'out-over', name: 'OVER', odds: 1.92 },
          { id: 'out-under', name: 'UNDER', odds: 1.88 },
        ],
      },
    ],
  },
  {
    category: 'Crypto',
    title: 'BTC Daily Close',
    startsAt: 'Today 23:59',
    markets: [
      {
        id: 'mkt-btc-close',
        question: 'BTC closes above 70k?',
        source: 'Exchange close price',
        outcomes: [
          { id: 'out-btc-yes', name: 'YES', odds: 2.15 },
          { id: 'out-btc-no', name: 'NO', odds: 1.72 },
        ],
      },
    ],
  },
  {
    category: 'Culture',
    title: 'Award Night',
    startsAt: 'Friday 22:00',
    markets: [
      {
        id: 'mkt-award',
        question: 'Will the host mention AI?',
        source: 'Broadcast',
        outcomes: [
          { id: 'out-ai-yes', name: 'YES', odds: 1.48 },
          { id: 'out-ai-no', name: 'NO', odds: 2.6 },
        ],
      },
    ],
  },
];

let selectedCategory = 'Politics';
let selected = null;

const eventsList = document.querySelector('#eventsList');
const categoryTitle = document.querySelector('#categoryTitle');
const betSlip = document.querySelector('#betSlip');
const emptySlip = document.querySelector('#emptySlip');
const activeSlip = document.querySelector('#activeSlip');
const stakeInput = document.querySelector('#stakeInput');
const acceptedBet = document.querySelector('#acceptedBet');

function fmtXan(value) {
  return `${Number(value).toFixed(2)} XAN`;
}

function renderEvents() {
  categoryTitle.textContent = selectedCategory;
  const events = data.filter((event) => event.category === selectedCategory);
  eventsList.innerHTML = events.map((event) => `
    <article class="event-card">
      <div class="event-head">
        <div class="event-title">${event.title}</div>
        <div class="event-meta">${event.startsAt}</div>
      </div>
      ${event.markets.map((market) => `
        <div class="market-row">
          <div>
            <div class="market-question">${market.question}</div>
            <div class="market-source">${market.source}</div>
          </div>
          <div class="outcomes">
            ${market.outcomes.map((outcome) => `
              <button class="outcome-button ${selected?.outcome.id === outcome.id ? 'selected' : ''}"
                data-event="${event.title}"
                data-market-id="${market.id}"
                data-market="${market.question}"
                data-outcome-id="${outcome.id}"
                data-outcome="${outcome.name}"
                data-odds="${outcome.odds}">
                <span class="outcome-name">${outcome.name}</span>
                <span class="odds">${outcome.odds.toFixed(2)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </article>
  `).join('');
}

function renderSlip() {
  const hasSelection = Boolean(selected);
  betSlip.classList.toggle('empty', !hasSelection);
  emptySlip.hidden = hasSelection;
  activeSlip.hidden = !hasSelection;

  if (!selected) return;

  const stake = Number(stakeInput.value || 0);
  const payout = stake * selected.outcome.odds;
  const profit = payout - stake;

  document.querySelector('#slipTitle').textContent = selected.outcome.name;
  document.querySelector('#slipEvent').textContent = selected.event;
  document.querySelector('#slipMarket').textContent = selected.market.question;
  document.querySelector('#slipOutcome').textContent = selected.outcome.name;
  document.querySelector('#slipOdds').textContent = selected.outcome.odds.toFixed(2);
  document.querySelector('#previewPayout').textContent = fmtXan(payout);
  document.querySelector('#previewProfit').textContent = fmtXan(profit);
}

document.querySelectorAll('.category').forEach((button) => {
  button.addEventListener('click', () => {
    selectedCategory = button.dataset.category;
    document.querySelectorAll('.category').forEach((item) => item.classList.toggle('active', item === button));
    selected = null;
    acceptedBet.hidden = true;
    renderEvents();
    renderSlip();
  });
});

eventsList.addEventListener('click', (event) => {
  const button = event.target.closest('.outcome-button');
  if (!button) return;

  selected = {
    event: button.dataset.event,
    market: { id: button.dataset.marketId, question: button.dataset.market },
    outcome: {
      id: button.dataset.outcomeId,
      name: button.dataset.outcome,
      odds: Number(button.dataset.odds),
    },
  };
  acceptedBet.hidden = true;
  renderEvents();
  renderSlip();
});

stakeInput.addEventListener('input', () => {
  if (Number(stakeInput.value) > 1) stakeInput.value = 1;
  if (Number(stakeInput.value) < 1) stakeInput.value = 1;
  acceptedBet.hidden = true;
  renderSlip();
});

document.querySelector('#clearSlip').addEventListener('click', () => {
  selected = null;
  acceptedBet.hidden = true;
  renderEvents();
  renderSlip();
});

document.querySelector('#placeBet').addEventListener('click', () => {
  if (!selected) return;

  const stake = Number(stakeInput.value || 1);
  const acceptedOdds = selected.outcome.odds;
  const potentialPayout = stake * acceptedOdds;
  const betId = `BET-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const timestamp = new Date().toISOString();

  document.querySelector('#acceptedId').textContent = betId;
  document.querySelector('#acceptedOdds').textContent = acceptedOdds.toFixed(2);
  document.querySelector('#acceptedStake').textContent = fmtXan(stake);
  document.querySelector('#acceptedPayout').textContent = fmtXan(potentialPayout);
  document.querySelector('#acceptedTimestamp').textContent = timestamp;
  acceptedBet.hidden = false;
});

renderEvents();
renderSlip();
