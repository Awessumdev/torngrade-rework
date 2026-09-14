import React from 'react';

export default function Page() {
  return React.createElement(
    'main',
    { className: 'app-shell' },
    React.createElement(
      'header',
      { className: 'topbar' },
      React.createElement(
        'div',
        null,
        React.createElement('div', { className: 'brand' }, 'Torngrade'),
        React.createElement('div', { className: 'subline' }, 'Fixed odds event markets'),
      ),
      React.createElement(
        'div',
        { className: 'wallet-panel', 'aria-label': 'Wallet balance' },
        React.createElement('span', null, 'Production API'),
        React.createElement('strong', null, 'Online'),
      ),
    ),
    React.createElement(
      'div',
      { className: 'layout' },
      React.createElement(
        'aside',
        { className: 'categories', 'aria-label': 'Categories' },
        React.createElement('div', { className: 'section-title' }, 'Categories'),
        ['Politics', 'Sports', 'Crypto', 'Culture'].map((category, index) => React.createElement(
          'button',
          {
            key: category,
            className: `category${index === 0 ? ' active' : ''}`,
            'data-category': category,
            type: 'button',
          },
          category,
        )),
      ),
      React.createElement(
        'section',
        { className: 'markets-area' },
        React.createElement(
          'div',
          { className: 'toolbar' },
          React.createElement(
            'div',
            null,
            React.createElement('h1', { id: 'categoryTitle' }, 'Politics'),
            React.createElement('p', null, 'Select an outcome to open the bet slip'),
          ),
          React.createElement('div', { className: 'status-pill' }, 'OPEN MARKETS'),
        ),
        React.createElement('div', { id: 'eventsList', className: 'events-list' }),
      ),
      React.createElement(
        'aside',
        { id: 'betSlip', className: 'bet-slip empty', 'aria-label': 'Bet slip' },
        React.createElement(
          'div',
          { className: 'slip-header' },
          React.createElement(
            'div',
            null,
            React.createElement('div', { className: 'section-title' }, 'Bet Slip'),
            React.createElement('h2', { id: 'slipTitle' }, 'No selection'),
          ),
          React.createElement('button', { id: 'clearSlip', className: 'icon-button', type: 'button', 'aria-label': 'Clear bet slip' }, 'x'),
        ),
        React.createElement('div', { id: 'emptySlip', className: 'empty-state' }, 'Pick an outcome to preview stake, payout, and profit.'),
        React.createElement(
          'div',
          { id: 'activeSlip', className: 'slip-content', hidden: true },
          React.createElement(
            'dl',
            { className: 'bet-details' },
            detail('Event', 'slipEvent'),
            detail('Market', 'slipMarket'),
            detail('Outcome', 'slipOutcome'),
            detail('Current Odds', 'slipOdds'),
          ),
          React.createElement(
            'label',
            { className: 'stake-field' },
            React.createElement('span', null, 'Stake'),
            React.createElement('input', { id: 'stakeInput', type: 'number', min: '1', max: '1', step: '1', defaultValue: '1' }),
            React.createElement('em', null, 'XAN'),
          ),
          React.createElement(
            'div',
            { className: 'preview-grid' },
            React.createElement('div', null, React.createElement('span', null, 'Potential Payout'), React.createElement('strong', { id: 'previewPayout' }, '0.00 XAN')),
            React.createElement('div', null, React.createElement('span', null, 'Potential Profit'), React.createElement('strong', { id: 'previewProfit' }, '0.00 XAN')),
          ),
          React.createElement('button', { id: 'placeBet', className: 'place-button', type: 'button' }, 'PLACE BET'),
          React.createElement(
            'section',
            { id: 'acceptedBet', className: 'accepted', hidden: true },
            React.createElement('div', { className: 'accepted-title' }, 'Bet Accepted'),
            React.createElement(
              'dl',
              null,
              detail('Bet ID', 'acceptedId'),
              detail('Accepted Odds', 'acceptedOdds'),
              detail('Stake', 'acceptedStake'),
              detail('Potential Payout', 'acceptedPayout'),
              detail('Timestamp', 'acceptedTimestamp'),
            ),
          ),
        ),
      ),
    ),
    React.createElement('script', { src: '/app.js', defer: true }),
  );
}

function detail(label, id) {
  return React.createElement(
    'div',
    { key: id },
    React.createElement('dt', null, label),
    React.createElement('dd', { id }),
  );
}
