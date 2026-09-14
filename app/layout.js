import './globals.css';
import React from 'react';

export const metadata = {
  title: 'Torngrade Sportsbook',
  description: 'Fixed odds event markets',
};

export default function RootLayout({ children }) {
  return React.createElement(
    'html',
    { lang: 'en' },
    React.createElement('body', null, children),
  );
}
