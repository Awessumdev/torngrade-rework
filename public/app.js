let data = [];
let selectedCategory = 'All';
let selected = null;
let csrfToken = window.localStorage.getItem('torngrade_csrf') || '';

const eventsList = document.querySelector('#eventsList');
const categoryTitle = document.querySelector('#categoryTitle');
const betSlip = document.querySelector('#betSlip');
const emptySlip = document.querySelector('#emptySlip');
const activeSlip = document.querySelector('#activeSlip');
const stakeInput = document.querySelector('#stakeInput');
const acceptedBet = document.querySelector('#acceptedBet');
const authMessage = document.querySelector('#authMessage');
const sessionStatus = document.querySelector('#sessionStatus');
const walletBalance = document.querySelector('#walletBalance');
const loginForm = document.querySelector('#tornLoginForm');
const apiKeyInput = document.querySelector('#tornApiKey');
const logoutButton = document.querySelector('#logoutButton');

function fmtXan(value) {
  return `${Number(value).toFixed(2)} XAN`;
}

function setMessage(message, isError = false) {
  authMessage.textContent = message || '';
  authMessage.classList.toggle('error', isError);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(csrfToken && options.method && options.method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || 'Request failed.');
  }
  return payload;
}

function normalizeEvents(events) {
  return events.map((event) => ({
    id: event.id,
    category: event.category || 'Other',
    title: event.title,
    startsAt: new Date(event.startsAt).toLocaleString(),
    markets: event.markets.map((market) => ({
      id: market.id,
      question: market.question,
      source: market.resolutionSource || market.status,
      status: market.status,
      outcomes: market.outcomes.map((outcome) => ({
        id: outcome.id,
        name: outcome.name,
        odds: Number(outcome.odds),
        status: outcome.status,
      })),
    })),
  }));
}

function categories() {
  return ['All', ...Array.from(new Set(data.map((event) => event.category))).sort()];
}

function renderCategories() {
  document.querySelectorAll('.category').forEach((button) => button.remove());
  const container = document.querySelector('.categories');
  for (const category of categories()) {
    const button = document.createElement('button');
    button.className = `category${category === selectedCategory ? ' active' : ''}`;
    button.dataset.category = category;
    button.type = 'button';
    button.textContent = category;
    container.appendChild(button);
  }
}

function filteredEvents() {
  if (selectedCategory === 'All') return data;
  return data.filter((event) => event.category === selectedCategory);
}

function renderEvents() {
  categoryTitle.textContent = selectedCategory === 'All' ? 'Markets' : selectedCategory;
  const events = filteredEvents();
  if (!events.length) {
    eventsList.innerHTML = '<div class="empty-state">No open markets right now.</div>';
    return;
  }

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
                data-event-id="${event.id}"
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
  document.querySelector('#slipEvent').textContent = selected.event.title;
  document.querySelector('#slipMarket').textContent = selected.market.question;
  document.querySelector('#slipOutcome').textContent = selected.outcome.name;
  document.querySelector('#slipOdds').textContent = selected.outcome.odds.toFixed(2);
  document.querySelector('#previewPayout').textContent = fmtXan(payout);
  document.querySelector('#previewProfit').textContent = fmtXan(profit);
}

async function loadMarkets() {
  const payload = await api('/api/markets');
  data = normalizeEvents(payload.events || []);
  selectedCategory = categories()[0] || 'All';
  renderCategories();
  renderEvents();
  renderSlip();
}

async function loadSession() {
  try {
    const payload = await api('/api/me');
    sessionStatus.textContent = payload.user.username;
    walletBalance.textContent = fmtXan(payload.user.wallet?.availableBalance || 0);
    logoutButton.hidden = false;
    apiKeyInput.value = '';
    setMessage('Signed in with Torn.');
  } catch {
    csrfToken = '';
    window.localStorage.removeItem('torngrade_csrf');
    sessionStatus.textContent = 'Not signed in';
    walletBalance.textContent = '0.00 XAN';
    logoutButton.hidden = true;
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('Checking Torn API key...');
  try {
    const payload = await api('/api/auth/torn', {
      method: 'POST',
      body: JSON.stringify({ apiKey: apiKeyInput.value }),
    });
    csrfToken = payload.csrfToken;
    window.localStorage.setItem('torngrade_csrf', csrfToken);
    await loadSession();
  } catch (error) {
    setMessage(error.message, true);
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ type: 'USER' }),
    });
  } catch {
    // Local session state is cleared even if the server cookie is already gone.
  }
  csrfToken = '';
  window.localStorage.removeItem('torngrade_csrf');
  selected = null;
  acceptedBet.hidden = true;
  await loadSession();
  renderSlip();
});

document.querySelector('.categories').addEventListener('click', (event) => {
  const button = event.target.closest('.category');
  if (!button) return;
  selectedCategory = button.dataset.category;
  document.querySelectorAll('.category').forEach((item) => item.classList.toggle('active', item === button));
  selected = null;
  acceptedBet.hidden = true;
  renderEvents();
  renderSlip();
});

eventsList.addEventListener('click', (event) => {
  const button = event.target.closest('.outcome-button');
  if (!button) return;

  selected = {
    event: { id: button.dataset.eventId, title: button.dataset.event },
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

document.querySelector('#placeBet').addEventListener('click', async () => {
  if (!selected) return;
  setMessage('');

  try {
    const payload = await api('/api/bets', {
      method: 'POST',
      body: JSON.stringify({
        marketId: selected.market.id,
        outcomeId: selected.outcome.id,
        stake: String(Number(stakeInput.value || 1)),
      }),
    });

    document.querySelector('#acceptedId').textContent = payload.bet.id;
    document.querySelector('#acceptedOdds').textContent = Number(payload.bet.acceptedOdds).toFixed(2);
    document.querySelector('#acceptedStake').textContent = fmtXan(payload.bet.stake);
    document.querySelector('#acceptedPayout').textContent = fmtXan(payload.bet.potentialPayout);
    document.querySelector('#acceptedTimestamp').textContent = new Date(payload.bet.placedAt).toLocaleString();
    walletBalance.textContent = fmtXan(payload.wallet.availableBalance);
    acceptedBet.hidden = false;
  } catch (error) {
    setMessage(error.message, true);
  }
});

loadMarkets().catch((error) => {
  eventsList.innerHTML = `<div class="empty-state">${error.message}</div>`;
});
loadSession();
