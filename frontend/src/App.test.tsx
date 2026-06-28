import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders ClearFlow header', () => {
  render(<App />);
  const heading = screen.getByText(/ClearFlow/i);
  expect(heading).toBeInTheDocument();
});

test('renders view switcher with tabs', () => {
  render(<App />);
  expect(screen.getByText(/All Parties/i)).toBeInTheDocument();
  expect(screen.getByText(/Seller View/i)).toBeInTheDocument();
  expect(screen.getByText(/Lender A View/i)).toBeInTheDocument();
  expect(screen.getByText(/Lender B View/i)).toBeInTheDocument();
  expect(screen.getByText(/Privacy Audit/i)).toBeInTheDocument();
});
