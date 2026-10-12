// Paystack's popup script (token purchases in shop.js, cash deposits in winnings.js): loaded the first time it's needed.
// The browser only ever opens a payment the server started and gets an access code for; what counts is the server
// hearing from Paystack itself.
const PAYSTACK_JS = 'https://js.paystack.co/v2/inline.js';
let loading = null;

export function loadPaystack() {
  loading ||= new Promise((resolve, reject) => {
    if (window.PaystackPop) return resolve(window.PaystackPop);
    const s = document.createElement('script');
    s.src = PAYSTACK_JS;
    s.async = true;
    s.onload = () => (window.PaystackPop ? resolve(window.PaystackPop) : reject(new Error('no PaystackPop')));
    s.onerror = () => { loading = null; s.remove(); reject(new Error('Paystack script')); };
    document.head.append(s);
  });
  return loading;
}
