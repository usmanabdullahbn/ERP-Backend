/*
  Fixed codes for the control accounts the posting engine relies on.
  These are created once by the seed script and marked isSystem so they
  can't be renamed/deleted from the Chart of Accounts screen.
*/
module.exports = {
  ACCOUNTS_RECEIVABLE: '1100',
  INVENTORY_ASSET: '1200',
  INPUT_TAX_RECEIVABLE: '1300',
  ACCOUNTS_PAYABLE: '2100',
  SALES_TAX_PAYABLE: '2200',
  OPENING_BALANCE_EQUITY: '3900',
  SALES_REVENUE: '4000',
  COST_OF_GOODS_SOLD: '5000',
  PURCHASES_EXPENSE: '5900',
  DISCOUNT_ALLOWED: '5700', // settlement discount given to customers on receipts
  DISCOUNT_RECEIVED: '4400', // settlement discount given by suppliers on payments
  BANK_CASH_DEFAULT: '1000'
};
