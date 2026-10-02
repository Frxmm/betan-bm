-- Nuevas cajas para depósitos (separadas de Caja efectivo / TPV tarjeta)
INSERT INTO financial_accounts (id, property_id, name, is_default, is_credit_card, is_bank_account, count_in_shift, active)
VALUES
  (5, 1, 'Caja Depósito Cash', false, false, false, false, true),
  (6, 1, 'Caja Depósito CC',   false, true,  false, false, true)
ON CONFLICT (id) DO NOTHING;

-- Reasignar transacciones de depósito a las nuevas cajas
UPDATE financial_transactions SET financial_account_id = 5 WHERE payment_method = 'deposit';
UPDATE financial_transactions SET financial_account_id = 6 WHERE payment_method = 'deposit_cc';
