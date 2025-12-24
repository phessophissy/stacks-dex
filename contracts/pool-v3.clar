;; STACKS DEX - Constant Product AMM Pool Contract V3 (Clarity 3)
;; Features: Bidirectional swaps, skip fee when sender == recipient

(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; Fee configuration: 30 basis points = 0.30%
(define-constant FEE_BPS u30)
(define-constant BPS_DENOM u10000)

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

;; State variables
(define-data-var fee-recipient (optional principal) none)
(define-data-var reserve-x uint u0)
(define-data-var reserve-y uint u0)
(define-data-var total-fees-x uint u0)
(define-data-var total-fees-y uint u0)

;; Read-only functions
(define-read-only (get-reserves)
  { x: (var-get reserve-x), y: (var-get reserve-y) })

(define-read-only (get-fee-info)
  { fee-bps: FEE_BPS, denom: BPS_DENOM, recipient: (var-get fee-recipient) })

(define-read-only (get-total-fees)
  { fees-x: (var-get total-fees-x), fees-y: (var-get total-fees-y) })

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

(define-read-only (calculate-fee (amount uint))
  (/ (* amount FEE_BPS) BPS_DENOM))

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
      ;; Transfer fee only if sender != fee recipient (skip self-transfer)
      (if (and (> fee u0) (not (is-eq sender fee-addr)))
        (unwrap! (contract-call? token-x transfer fee sender fee-addr none) ERR_FEE_TRANSFER_FAILED)
        true)
      ;; Transfer input tokens to pool
      (unwrap! (contract-call? token-x transfer dx-to-pool sender (as-contract tx-sender) none) ERR_TRANSFER_X_FAILED)
      ;; Transfer output tokens to recipient
      (unwrap! (as-contract (contract-call? token-y transfer dy tx-sender recipient none)) ERR_TRANSFER_Y_FAILED)
      ;; Update reserves
      (var-set reserve-x (+ rx dx-to-pool))
      (var-set reserve-y (- ry dy))
      ;; Track fees (even if not transferred for self-swaps)
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
      ;; Transfer fee only if sender != fee recipient (skip self-transfer)
      (if (and (> fee u0) (not (is-eq sender fee-addr)))
        (unwrap! (contract-call? token-y transfer fee sender fee-addr none) ERR_FEE_TRANSFER_FAILED)
        true)
      ;; Transfer input tokens to pool
      (unwrap! (contract-call? token-y transfer dy-to-pool sender (as-contract tx-sender) none) ERR_TRANSFER_Y_FAILED)
      ;; Transfer output tokens to recipient
      (unwrap! (as-contract (contract-call? token-x transfer dx tx-sender recipient none)) ERR_TRANSFER_X_FAILED)
      ;; Update reserves
      (var-set reserve-x (- rx dx))
      (var-set reserve-y (+ ry dy-to-pool))
      ;; Track fees
      (var-set total-fees-y (+ (var-get total-fees-y) fee))
      (ok { dx: dx, dy: dy, fee: fee, recipient: recipient }))))

;; Initialize pool with initial liquidity
(define-public (initialize-pool 
    (token-x <ft-trait>)
    (token-y <ft-trait>)
    (amount-x uint)
    (amount-y uint))
  (begin
    (asserts! (and (is-eq (var-get reserve-x) u0) (is-eq (var-get reserve-y) u0)) ERR_ALREADY_INITIALIZED)
    (var-set fee-recipient (some tx-sender))
    (unwrap! (contract-call? token-x transfer amount-x tx-sender (as-contract tx-sender) none) ERR_TRANSFER_X_FAILED)
    (unwrap! (contract-call? token-y transfer amount-y tx-sender (as-contract tx-sender) none) ERR_TRANSFER_Y_FAILED)
    (var-set reserve-x amount-x)
    (var-set reserve-y amount-y)
    (ok { x: amount-x, y: amount-y, fee-recipient: tx-sender })))

;; Contract info
(define-read-only (get-contract-info)
  { 
    name: "stacks-dex-pool-v3", 
    version: "3.0.0", 
    fee-bps: FEE_BPS, 
    fee-recipient: (var-get fee-recipient), 
    reserve-x: (var-get reserve-x), 
    reserve-y: (var-get reserve-y), 
    total-fees-x: (var-get total-fees-x),
    total-fees-y: (var-get total-fees-y)
  })
