;; STACKS DEX - Pool Contract V4 (Clarity 3)
;; Features: Bidirectional swaps, LP shares, add/remove liquidity

(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; Fee configuration: 30 basis points = 0.30%
(define-constant FEE_BPS u30)
(define-constant BPS_DENOM u10000)
(define-constant MINIMUM_LIQUIDITY u1000)

;; Error codes
(define-constant ERR_ZERO_INPUT (err u100))
(define-constant ERR_ZERO_RESERVES (err u101))
(define-constant ERR_DEADLINE_EXPIRED (err u102))
(define-constant ERR_SLIPPAGE_EXCEEDED (err u103))
(define-constant ERR_INSUFFICIENT_LIQUIDITY (err u104))
(define-constant ERR_TRANSFER_X_FAILED (err u105))
(define-constant ERR_TRANSFER_Y_FAILED (err u106))
(define-constant ERR_FEE_TRANSFER_FAILED (err u107))
(define-constant ERR_ALREADY_INITIALIZED (err u200))
(define-constant ERR_NOT_INITIALIZED (err u201))
(define-constant ERR_INSUFFICIENT_LP_BALANCE (err u202))
(define-constant ERR_ZERO_SHARES (err u203))
(define-constant ERR_MIN_LIQUIDITY (err u204))

;; State variables
(define-data-var fee-recipient (optional principal) none)
(define-data-var reserve-x uint u0)
(define-data-var reserve-y uint u0)
(define-data-var total-supply uint u0)
(define-data-var total-fees-x uint u0)
(define-data-var total-fees-y uint u0)

;; LP share balances
(define-map lp-balances principal uint)

;; Read-only functions
(define-read-only (get-reserves)
  { x: (var-get reserve-x), y: (var-get reserve-y) })

(define-read-only (get-fee-info)
  { fee-bps: FEE_BPS, denom: BPS_DENOM, recipient: (var-get fee-recipient) })

(define-read-only (get-total-fees)
  { fees-x: (var-get total-fees-x), fees-y: (var-get total-fees-y) })

(define-read-only (get-total-supply)
  (var-get total-supply))

(define-read-only (get-lp-balance (user principal))
  (default-to u0 (map-get? lp-balances user)))

(define-read-only (get-pool-share (user principal))
  (let ((balance (get-lp-balance user))
        (supply (var-get total-supply)))
    (if (is-eq supply u0)
      u0
      (/ (* balance u10000) supply))))

(define-read-only (get-user-liquidity (user principal))
  (let ((balance (get-lp-balance user))
        (supply (var-get total-supply))
        (rx (var-get reserve-x))
        (ry (var-get reserve-y)))
    (if (or (is-eq supply u0) (is-eq balance u0))
      { x: u0, y: u0, shares: u0 }
      { x: (/ (* balance rx) supply), 
        y: (/ (* balance ry) supply), 
        shares: balance })))

(define-read-only (quote-x-for-y (dx uint))
  (let ((rx (var-get reserve-x)) (ry (var-get reserve-y)))
    (asserts! (> dx u0) ERR_ZERO_INPUT)
    (asserts! (and (> rx u0) (> ry u0)) ERR_ZERO_RESERVES)
    (let ((fee (/ (* dx FEE_BPS) BPS_DENOM))
          (dx-to-pool (- dx fee))
          (dy (/ (* ry dx-to-pool) (+ rx dx-to-pool))))
      (asserts! (< dy ry) ERR_INSUFFICIENT_LIQUIDITY)
      (ok { dy: dy, fee: fee }))))

(define-read-only (quote-y-for-x (dy uint))
  (let ((rx (var-get reserve-x)) (ry (var-get reserve-y)))
    (asserts! (> dy u0) ERR_ZERO_INPUT)
    (asserts! (and (> rx u0) (> ry u0)) ERR_ZERO_RESERVES)
    (let ((fee (/ (* dy FEE_BPS) BPS_DENOM))
          (dy-to-pool (- dy fee))
          (dx (/ (* rx dy-to-pool) (+ ry dy-to-pool))))
      (asserts! (< dx rx) ERR_INSUFFICIENT_LIQUIDITY)
      (ok { dx: dx, fee: fee }))))

(define-read-only (quote-add-liquidity (amount-x uint) (amount-y uint))
  (let ((rx (var-get reserve-x))
        (ry (var-get reserve-y))
        (supply (var-get total-supply)))
    (if (is-eq supply u0)
      ;; First deposit: shares = sqrt(x * y)
      (ok { shares: (sqrti (* amount-x amount-y)), optimal-x: amount-x, optimal-y: amount-y })
      ;; Subsequent: calculate optimal amounts
      (let ((shares-from-x (/ (* amount-x supply) rx))
            (shares-from-y (/ (* amount-y supply) ry))
            (shares (if (< shares-from-x shares-from-y) shares-from-x shares-from-y))
            (optimal-x (/ (* shares rx) supply))
            (optimal-y (/ (* shares ry) supply)))
        (ok { shares: shares, optimal-x: optimal-x, optimal-y: optimal-y })))))

(define-read-only (quote-remove-liquidity (shares uint))
  (let ((supply (var-get total-supply))
        (rx (var-get reserve-x))
        (ry (var-get reserve-y)))
    (asserts! (> supply u0) ERR_NOT_INITIALIZED)
    (asserts! (> shares u0) ERR_ZERO_INPUT)
    (ok { 
      amount-x: (/ (* shares rx) supply),
      amount-y: (/ (* shares ry) supply)
    })))

;; Integer square root using Newton's method (non-recursive)
;; For simplicity, we use a formula that works for most cases
(define-read-only (sqrti (n uint))
  (if (<= n u1)
    n
    (if (<= n u3)
      u1
      (let ((x0 (/ n u2)))
        (let ((x1 (/ (+ x0 (/ n x0)) u2)))
          (let ((x2 (/ (+ x1 (/ n x1)) u2)))
            (let ((x3 (/ (+ x2 (/ n x2)) u2)))
              (let ((x4 (/ (+ x3 (/ n x3)) u2)))
                (let ((x5 (/ (+ x4 (/ n x4)) u2)))
                  (let ((x6 (/ (+ x5 (/ n x5)) u2)))
                    (let ((x7 (/ (+ x6 (/ n x6)) u2)))
                      (if (<= (* x7 x7) n) x7 (- x7 u1)))))))))))))

;; Swap X for Y (e.g., ALEX -> USDA)
(define-public (swap-x-for-y 
    (token-x <ft-trait>)
    (token-y <ft-trait>)
    (dx uint)
    (min-dy uint)
    (recipient principal)
    (deadline uint))
  (let ((rx (var-get reserve-x))
        (ry (var-get reserve-y))
        (sender tx-sender)
        (fee-addr (unwrap! (var-get fee-recipient) ERR_NOT_INITIALIZED)))
    (asserts! (<= stacks-block-height deadline) ERR_DEADLINE_EXPIRED)
    (asserts! (> dx u0) ERR_ZERO_INPUT)
    (asserts! (and (> rx u0) (> ry u0)) ERR_ZERO_RESERVES)
    (let ((fee (/ (* dx FEE_BPS) BPS_DENOM))
          (dx-to-pool (- dx fee))
          (dy (/ (* ry dx-to-pool) (+ rx dx-to-pool))))
      (asserts! (>= dy min-dy) ERR_SLIPPAGE_EXCEEDED)
      (asserts! (< dy ry) ERR_INSUFFICIENT_LIQUIDITY)
      (if (and (> fee u0) (not (is-eq sender fee-addr)))
        (unwrap! (contract-call? token-x transfer fee sender fee-addr none) ERR_FEE_TRANSFER_FAILED)
        true)
      (unwrap! (contract-call? token-x transfer dx-to-pool sender (as-contract tx-sender) none) ERR_TRANSFER_X_FAILED)
      (unwrap! (as-contract (contract-call? token-y transfer dy tx-sender recipient none)) ERR_TRANSFER_Y_FAILED)
      (var-set reserve-x (+ rx dx-to-pool))
      (var-set reserve-y (- ry dy))
      (var-set total-fees-x (+ (var-get total-fees-x) fee))
      (ok { dx: dx, dy: dy, fee: fee, recipient: recipient }))))

;; Swap Y for X (e.g., USDA -> ALEX)
(define-public (swap-y-for-x 
    (token-x <ft-trait>)
    (token-y <ft-trait>)
    (dy uint)
    (min-dx uint)
    (recipient principal)
    (deadline uint))
  (let ((rx (var-get reserve-x))
        (ry (var-get reserve-y))
        (sender tx-sender)
        (fee-addr (unwrap! (var-get fee-recipient) ERR_NOT_INITIALIZED)))
    (asserts! (<= stacks-block-height deadline) ERR_DEADLINE_EXPIRED)
    (asserts! (> dy u0) ERR_ZERO_INPUT)
    (asserts! (and (> rx u0) (> ry u0)) ERR_ZERO_RESERVES)
    (let ((fee (/ (* dy FEE_BPS) BPS_DENOM))
          (dy-to-pool (- dy fee))
          (dx (/ (* rx dy-to-pool) (+ ry dy-to-pool))))
      (asserts! (>= dx min-dx) ERR_SLIPPAGE_EXCEEDED)
      (asserts! (< dx rx) ERR_INSUFFICIENT_LIQUIDITY)
      (if (and (> fee u0) (not (is-eq sender fee-addr)))
        (unwrap! (contract-call? token-y transfer fee sender fee-addr none) ERR_FEE_TRANSFER_FAILED)
        true)
      (unwrap! (contract-call? token-y transfer dy-to-pool sender (as-contract tx-sender) none) ERR_TRANSFER_Y_FAILED)
      (unwrap! (as-contract (contract-call? token-x transfer dx tx-sender recipient none)) ERR_TRANSFER_X_FAILED)
      (var-set reserve-x (- rx dx))
      (var-set reserve-y (+ ry dy-to-pool))
      (var-set total-fees-y (+ (var-get total-fees-y) fee))
      (ok { dx: dx, dy: dy, fee: fee, recipient: recipient }))))

;; Initialize pool with initial liquidity (first LP)
(define-public (initialize-pool 
    (token-x <ft-trait>)
    (token-y <ft-trait>)
    (amount-x uint)
    (amount-y uint))
  (let ((sender tx-sender))
    (asserts! (and (is-eq (var-get reserve-x) u0) (is-eq (var-get reserve-y) u0)) ERR_ALREADY_INITIALIZED)
    (asserts! (and (> amount-x u0) (> amount-y u0)) ERR_ZERO_INPUT)
    (let ((shares (sqrti (* amount-x amount-y))))
      (asserts! (> shares MINIMUM_LIQUIDITY) ERR_MIN_LIQUIDITY)
      (var-set fee-recipient (some sender))
      (unwrap! (contract-call? token-x transfer amount-x sender (as-contract tx-sender) none) ERR_TRANSFER_X_FAILED)
      (unwrap! (contract-call? token-y transfer amount-y sender (as-contract tx-sender) none) ERR_TRANSFER_Y_FAILED)
      (var-set reserve-x amount-x)
      (var-set reserve-y amount-y)
      (var-set total-supply shares)
      (map-set lp-balances sender shares)
      (ok { shares: shares, x: amount-x, y: amount-y }))))

;; Add liquidity (subsequent LPs)
(define-public (add-liquidity
    (token-x <ft-trait>)
    (token-y <ft-trait>)
    (amount-x uint)
    (amount-y uint)
    (min-shares uint))
  (let ((rx (var-get reserve-x))
        (ry (var-get reserve-y))
        (supply (var-get total-supply))
        (sender tx-sender))
    (asserts! (> supply u0) ERR_NOT_INITIALIZED)
    (asserts! (and (> amount-x u0) (> amount-y u0)) ERR_ZERO_INPUT)
    ;; Calculate shares based on minimum contribution
    (let ((shares-from-x (/ (* amount-x supply) rx))
          (shares-from-y (/ (* amount-y supply) ry))
          (shares (if (< shares-from-x shares-from-y) shares-from-x shares-from-y))
          ;; Calculate actual amounts to deposit (proportional)
          (actual-x (/ (* shares rx) supply))
          (actual-y (/ (* shares ry) supply)))
      (asserts! (>= shares min-shares) ERR_SLIPPAGE_EXCEEDED)
      (asserts! (> shares u0) ERR_ZERO_SHARES)
      ;; Transfer tokens
      (unwrap! (contract-call? token-x transfer actual-x sender (as-contract tx-sender) none) ERR_TRANSFER_X_FAILED)
      (unwrap! (contract-call? token-y transfer actual-y sender (as-contract tx-sender) none) ERR_TRANSFER_Y_FAILED)
      ;; Update state
      (var-set reserve-x (+ rx actual-x))
      (var-set reserve-y (+ ry actual-y))
      (var-set total-supply (+ supply shares))
      (map-set lp-balances sender (+ (get-lp-balance sender) shares))
      (ok { shares: shares, x: actual-x, y: actual-y }))))

;; Remove liquidity
(define-public (remove-liquidity
    (token-x <ft-trait>)
    (token-y <ft-trait>)
    (shares uint)
    (min-x uint)
    (min-y uint))
  (let ((rx (var-get reserve-x))
        (ry (var-get reserve-y))
        (supply (var-get total-supply))
        (sender tx-sender)
        (user-balance (get-lp-balance sender)))
    (asserts! (> supply u0) ERR_NOT_INITIALIZED)
    (asserts! (> shares u0) ERR_ZERO_INPUT)
    (asserts! (>= user-balance shares) ERR_INSUFFICIENT_LP_BALANCE)
    ;; Calculate amounts to withdraw
    (let ((amount-x (/ (* shares rx) supply))
          (amount-y (/ (* shares ry) supply)))
      (asserts! (>= amount-x min-x) ERR_SLIPPAGE_EXCEEDED)
      (asserts! (>= amount-y min-y) ERR_SLIPPAGE_EXCEEDED)
      ;; Transfer tokens back
      (unwrap! (as-contract (contract-call? token-x transfer amount-x tx-sender sender none)) ERR_TRANSFER_X_FAILED)
      (unwrap! (as-contract (contract-call? token-y transfer amount-y tx-sender sender none)) ERR_TRANSFER_Y_FAILED)
      ;; Update state
      (var-set reserve-x (- rx amount-x))
      (var-set reserve-y (- ry amount-y))
      (var-set total-supply (- supply shares))
      (map-set lp-balances sender (- user-balance shares))
      (ok { shares: shares, x: amount-x, y: amount-y }))))

;; Contract info
(define-read-only (get-contract-info)
  {
    name: "stacks-dex-pool-v5",
    version: "4.0.0",
    fee-bps: FEE_BPS,
    fee-recipient: (var-get fee-recipient),
    reserve-x: (var-get reserve-x),
    reserve-y: (var-get reserve-y),
    total-supply: (var-get total-supply),
    total-fees-x: (var-get total-fees-x),
    total-fees-y: (var-get total-fees-y)
  })

;; Bulk Operations

;; Bulk swap X for Y (up to 10 swaps in one transaction)
(define-private (bulk-swap-x-for-y-internal
  (swap-data {token-x: <ft-trait>, token-y: <ft-trait>, dx: uint, min-dy: uint, recipient: principal, deadline: uint}))
  (let
    (
      (token-x (get token-x swap-data))
      (token-y (get token-y swap-data))
      (dx (get dx swap-data))
      (min-dy (get min-dy swap-data))
      (recipient (get recipient swap-data))
      (deadline (get deadline swap-data))
    )
    ;; Call the main swap function
    (swap-x-for-y token-x token-y dx min-dy recipient deadline)
  )
)

(define-public (bulk-swap-x-for-y
  (swaps (list 10 {token-x: <ft-trait>, token-y: <ft-trait>, dx: uint, min-dy: uint, recipient: principal, deadline: uint})))
  (begin
    (asserts! (> (len swaps) u0) ERR_ZERO_INPUT)
    ;; Process all swaps - each will validate individually
    (ok (map bulk-swap-x-for-y-internal swaps))
  )
)

;; Bulk swap Y for X (up to 10 swaps in one transaction)
(define-private (bulk-swap-y-for-x-internal
  (swap-data {token-x: <ft-trait>, token-y: <ft-trait>, dy: uint, min-dx: uint, recipient: principal, deadline: uint}))
  (let
    (
      (token-x (get token-x swap-data))
      (token-y (get token-y swap-data))
      (dy (get dy swap-data))
      (min-dx (get min-dx swap-data))
      (recipient (get recipient swap-data))
      (deadline (get deadline swap-data))
    )
    ;; Call the main swap function
    (swap-y-for-x token-x token-y dy min-dx recipient deadline)
  )
)

(define-public (bulk-swap-y-for-x
  (swaps (list 10 {token-x: <ft-trait>, token-y: <ft-trait>, dy: uint, min-dx: uint, recipient: principal, deadline: uint})))
  (begin
    (asserts! (> (len swaps) u0) ERR_ZERO_INPUT)
    ;; Process all swaps - each will validate individually
    (ok (map bulk-swap-y-for-x-internal swaps))
  )
)

;; Bulk add liquidity (up to 5 liquidity additions in one transaction)
(define-private (bulk-add-liquidity-internal
  (liquidity-data {token-x: <ft-trait>, token-y: <ft-trait>, amount-x: uint, amount-y: uint, min-shares: uint}))
  (let
    (
      (token-x (get token-x liquidity-data))
      (token-y (get token-y liquidity-data))
      (amount-x (get amount-x liquidity-data))
      (amount-y (get amount-y liquidity-data))
      (min-shares (get min-shares liquidity-data))
    )
    ;; Call the main add-liquidity function
    (add-liquidity token-x token-y amount-x amount-y min-shares)
  )
)

(define-public (bulk-add-liquidity
  (liquidity-additions (list 5 {token-x: <ft-trait>, token-y: <ft-trait>, amount-x: uint, amount-y: uint, min-shares: uint})))
  (begin
    (asserts! (> (len liquidity-additions) u0) ERR_ZERO_INPUT)
    ;; Process all liquidity additions - each will validate individually
    (ok (map bulk-add-liquidity-internal liquidity-additions))
  )
)

;; Bulk remove liquidity (up to 5 liquidity removals in one transaction)
(define-private (bulk-remove-liquidity-internal
  (removal-data {token-x: <ft-trait>, token-y: <ft-trait>, shares: uint, min-x: uint, min-y: uint}))
  (let
    (
      (token-x (get token-x removal-data))
      (token-y (get token-y removal-data))
      (shares (get shares removal-data))
      (min-x (get min-x removal-data))
      (min-y (get min-y removal-data))
    )
    ;; Call the main remove-liquidity function
    (remove-liquidity token-x token-y shares min-x min-y)
  )
)

(define-public (bulk-remove-liquidity
  (liquidity-removals (list 5 {token-x: <ft-trait>, token-y: <ft-trait>, shares: uint, min-x: uint, min-y: uint})))
  (begin
    (asserts! (> (len liquidity-removals) u0) ERR_ZERO_INPUT)
    ;; Process all liquidity removals - each will validate individually
    (ok (map bulk-remove-liquidity-internal liquidity-removals))
  )
)
