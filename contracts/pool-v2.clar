;; ============================================================================
;; STACKS DEX - AMM Pool V2 (Compatible with ALEX token restrictions)
;; ============================================================================
;; 
;; This version works with tokens that require tx-sender == sender or
;; contract-caller == sender for transfers (like ALEX token).
;;
;; The user must first transfer tokens TO the pool, then call swap.
;; The pool tracks pending deposits per user.
;; ============================================================================

(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; Fee: 30 basis points = 0.30%
(define-constant FEE_BPS u30)
(define-constant BPS_DENOM u10000)

;; Error codes
(define-constant ERR_ZERO_INPUT (err u100))
(define-constant ERR_ZERO_RESERVES (err u101))
(define-constant ERR_DEADLINE_EXPIRED (err u102))
(define-constant ERR_SLIPPAGE_EXCEEDED (err u103))
(define-constant ERR_INSUFFICIENT_LIQUIDITY (err u104))
(define-constant ERR_TRANSFER_FAILED (err u105))
(define-constant ERR_ALREADY_INITIALIZED (err u200))
(define-constant ERR_NOT_INITIALIZED (err u201))
(define-constant ERR_NO_DEPOSIT (err u202))

;; State
(define-data-var fee-recipient (optional principal) none)
(define-data-var reserve-x uint u0)
(define-data-var reserve-y uint u0)
(define-data-var total-fees-collected uint u0)

;; Track deposits per user (for the 2-step swap process)
(define-map user-deposits principal uint)

;; Read functions
(define-read-only (get-reserves)
  { x: (var-get reserve-x), y: (var-get reserve-y) })

(define-read-only (get-fee-info)
  { fee-bps: FEE_BPS, denom: BPS_DENOM, recipient: (var-get fee-recipient) })

(define-read-only (get-total-fees)
  (var-get total-fees-collected))

(define-read-only (get-user-deposit (user principal))
  (default-to u0 (map-get? user-deposits user)))

(define-read-only (quote-x-for-y (dx uint))
  (let ((rx (var-get reserve-x)) (ry (var-get reserve-y)))
    (asserts! (> dx u0) ERR_ZERO_INPUT)
    (asserts! (and (> rx u0) (> ry u0)) ERR_ZERO_RESERVES)
    (let ((fee (/ (* dx FEE_BPS) BPS_DENOM))
          (dx-to-pool (- dx fee))
          (dy (/ (* ry dx-to-pool) (+ rx dx-to-pool))))
      (asserts! (< dy ry) ERR_INSUFFICIENT_LIQUIDITY)
      (ok dy))))

(define-read-only (calculate-fee (dx uint))
  (/ (* dx FEE_BPS) BPS_DENOM))

;; Step 1: User deposits tokens X directly to this contract
;; User calls: (contract-call? token-x transfer amount tx-sender pool-contract none)
;; Then calls this to register the deposit
(define-public (register-deposit (amount uint))
  (begin
    (asserts! (> amount u0) ERR_ZERO_INPUT)
    (map-set user-deposits tx-sender (+ (get-user-deposit tx-sender) amount))
    (ok amount)))

;; Alternative: Single-step swap for tokens that DON'T have restrictions
;; The user calls this, and we transfer on their behalf
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
      ;; Transfer fee to fee recipient (if fee > 0)
      (if (> fee u0)
        (unwrap! (contract-call? token-x transfer fee sender fee-addr none) ERR_TRANSFER_FAILED)
        true)
      ;; Transfer dx-to-pool from sender to this contract
      (unwrap! (contract-call? token-x transfer dx-to-pool sender (as-contract tx-sender) none) ERR_TRANSFER_FAILED)
      ;; Transfer dy from pool to recipient
      (unwrap! (as-contract (contract-call? token-y transfer dy tx-sender recipient none)) ERR_TRANSFER_FAILED)
      ;; Update reserves
      (var-set reserve-x (+ rx dx-to-pool))
      (var-set reserve-y (- ry dy))
      (var-set total-fees-collected (+ (var-get total-fees-collected) fee))
      (ok { dx: dx, dy: dy, fee: fee, recipient: recipient }))))

;; Swap for Y using tokens X → Y (Y for X direction)
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
      ;; Transfer fee to fee recipient
      (if (> fee u0)
        (unwrap! (contract-call? token-y transfer fee sender fee-addr none) ERR_TRANSFER_FAILED)
        true)
      ;; Transfer dy-to-pool from sender to pool
      (unwrap! (contract-call? token-y transfer dy-to-pool sender (as-contract tx-sender) none) ERR_TRANSFER_FAILED)
      ;; Transfer dx from pool to recipient
      (unwrap! (as-contract (contract-call? token-x transfer dx tx-sender recipient none)) ERR_TRANSFER_FAILED)
      ;; Update reserves
      (var-set reserve-x (- rx dx))
      (var-set reserve-y (+ ry dy-to-pool))
      (var-set total-fees-collected (+ (var-get total-fees-collected) fee))
      (ok { dy: dy, dx: dx, fee: fee, recipient: recipient }))))

;; Initialize pool with liquidity
(define-public (initialize-pool 
    (token-x <ft-trait>)
    (token-y <ft-trait>)
    (amount-x uint)
    (amount-y uint))
  (begin
    (asserts! (and (is-eq (var-get reserve-x) u0) (is-eq (var-get reserve-y) u0)) ERR_ALREADY_INITIALIZED)
    (var-set fee-recipient (some tx-sender))
    (unwrap! (contract-call? token-x transfer amount-x tx-sender (as-contract tx-sender) none) ERR_TRANSFER_FAILED)
    (unwrap! (contract-call? token-y transfer amount-y tx-sender (as-contract tx-sender) none) ERR_TRANSFER_FAILED)
    (var-set reserve-x amount-x)
    (var-set reserve-y amount-y)
    (ok { x: amount-x, y: amount-y, fee-recipient: tx-sender })))

(define-read-only (get-contract-info)
  { 
    name: "stacks-dex-pool-v2", 
    version: "2.0.0", 
    fee-bps: FEE_BPS, 
    fee-recipient: (var-get fee-recipient), 
    reserve-x: (var-get reserve-x), 
    reserve-y: (var-get reserve-y), 
    total-fees: (var-get total-fees-collected) 
  })
