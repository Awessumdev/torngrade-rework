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
      'section',
      { className: 'market-board' },
      React.createElement(
        'div',
        { className: 'section-heading' },
        React.createElement('span', null, 'Backend Ready'),
        React.createElement('strong', null, 'Financial routes are server-authoritative'),
      ),
    ),
  );
}
