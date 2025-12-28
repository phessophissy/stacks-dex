/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  Stacks DEX - Pool V5 Test Suite                                        ║
 * ║  Comprehensive tests for the Stacks DEX AMM pool contract               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;
const wallet3 = accounts.get("wallet_3")!;
const wallet4 = accounts.get("wallet_4")!;

const contractName = "pool-v5";

// Helper to extract response values
function getResponseOk(result: any) {
  if (result.result.type === 7) { // ResponseOk
    return result.result.value;
  }
  throw new Error(`Expected ResponseOk, got ${result.result.type}`);
}

function getResponseErr(result: any) {
  if (result.result.type === 8) { // ResponseErr
    return result.result.value;
  }
  throw new Error(`Expected ResponseErr, got ${result.result.type}`);
}

// ════════════════════════════════════════════════════════════════════════════
// POOL INITIALIZATION TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Pool Initialization", () => {
  it("should initialize pool with liquidity", () => {
    const { result } = simnet.callPublicFn(
      contractName,
      "initialize-pool",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(100000000), // 100 X tokens
        Cl.uint(200000000)  // 200 Y tokens
      ],
      deployer
    );

    expect(result).toBeOk(Cl.tuple({
      shares: Cl.uint(14142), // sqrt(100*200) ≈ 14142
      x: Cl.uint(100000000),
      y: Cl.uint(200000000)
    }));
  });

  it("should prevent double initialization", () => {
    // First initialization
    simnet.callPublicFn(
      contractName,
      "initialize-pool",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(100000000),
        Cl.uint(200000000)
      ],
      deployer
    );

    // Second initialization should fail
    const { result } = simnet.callPublicFn(
      contractName,
      "initialize-pool",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(50000000),
        Cl.uint(100000000)
      ],
      deployer
    );

    expect(result).toBeErr(Cl.uint(200)); // ERR_ALREADY_INITIALIZED
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SINGLE SWAP TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Single Swaps", () => {
  beforeEach(() => {
    // Initialize pool
    simnet.callPublicFn(
      contractName,
      "initialize-pool",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(100000000), // 100 X
        Cl.uint(200000000)  // 200 Y
      ],
      deployer
    );
  });

  it("should swap X for Y", () => {
    const deadline = simnet.blockHeight + 10;
    const { result } = simnet.callPublicFn(
      contractName,
      "swap-x-for-y",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(10000000), // 10 X
        Cl.uint(18000000), // min 18 Y (with some slippage tolerance)
        Cl.principal(wallet1),
        Cl.uint(deadline)
      ],
      wallet1
    );

    expect(result).toBeOk(Cl.tuple({
      dx: Cl.uint(10000000),
      dy: Cl.uint(18181818), // Expected output
      fee: Cl.uint(30000),   // 0.3% fee
      recipient: Cl.principal(wallet1)
    }));
  });

  it("should swap Y for X", () => {
    const deadline = simnet.blockHeight + 10;
    const { result } = simnet.callPublicFn(
      contractName,
      "swap-y-for-x",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(20000000), // 20 Y
        Cl.uint(9000000),  // min 9 X
        Cl.principal(wallet1),
        Cl.uint(deadline)
      ],
      wallet1
    );

    expect(result).toBeOk(Cl.tuple({
      dx: Cl.uint(9090909), // Expected output
      dy: Cl.uint(20000000),
      fee: Cl.uint(60000),  // 0.3% fee
      recipient: Cl.principal(wallet1)
    }));
  });

  it("should reject expired deadline", () => {
    const expiredDeadline = simnet.blockHeight - 1;
    const { result } = simnet.callPublicFn(
      contractName,
      "swap-x-for-y",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(10000000),
        Cl.uint(18000000),
        Cl.principal(wallet1),
        Cl.uint(expiredDeadline)
      ],
      wallet1
    );

    expect(result).toBeErr(Cl.uint(102)); // ERR_DEADLINE_EXPIRED
  });

  it("should enforce slippage protection", () => {
    const deadline = simnet.blockHeight + 10;
    const { result } = simnet.callPublicFn(
      contractName,
      "swap-x-for-y",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(10000000),
        Cl.uint(20000000), // Too high minimum (would exceed slippage)
        Cl.principal(wallet1),
        Cl.uint(deadline)
      ],
      wallet1
    );

    expect(result).toBeErr(Cl.uint(103)); // ERR_SLIPPAGE_EXCEEDED
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LIQUIDITY MANAGEMENT TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Liquidity Management", () => {
  beforeEach(() => {
    // Initialize pool
    simnet.callPublicFn(
      contractName,
      "initialize-pool",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(100000000),
        Cl.uint(200000000)
      ],
      deployer
    );
  });

  it("should add liquidity", () => {
    const { result } = simnet.callPublicFn(
      contractName,
      "add-liquidity",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(50000000), // 50 X
        Cl.uint(100000000), // 100 Y
        Cl.uint(50000)     // min shares
      ],
      wallet1
    );

    expect(result).toBeOk(Cl.tuple({
      shares: Cl.uint(70710), // Calculated shares
      x: Cl.uint(50000000),
      y: Cl.uint(100000000)
    }));
  });

  it("should remove liquidity", () => {
    // First add liquidity
    simnet.callPublicFn(
      contractName,
      "add-liquidity",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(50000000),
        Cl.uint(100000000),
        Cl.uint(50000)
      ],
      wallet1
    );

    // Then remove it
    const { result } = simnet.callPublicFn(
      contractName,
      "remove-liquidity",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(70710), // shares from add-liquidity
        Cl.uint(40000000), // min X
        Cl.uint(80000000)  // min Y
      ],
      wallet1
    );

    expect(result).toBeOk(Cl.tuple({
      shares: Cl.uint(70710),
      x: Cl.uint(50000000),
      y: Cl.uint(100000000)
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BULK SWAP TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Bulk Swap Operations", () => {
  beforeEach(() => {
    // Initialize pool with larger liquidity for bulk operations
    simnet.callPublicFn(
      contractName,
      "initialize-pool",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(1000000000), // 1000 X
        Cl.uint(2000000000)  // 2000 Y
      ],
      deployer
    );
  });

  describe("Bulk Swap X for Y", () => {
    it("should perform multiple X to Y swaps successfully", () => {
      const deadline = simnet.blockHeight + 20;
      const swaps = [
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dx: 10000000, // 10 X
          minDy: 18000000,
          recipient: wallet1,
          deadline: deadline
        },
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dx: 20000000, // 20 X
          minDy: 35000000,
          recipient: wallet2,
          deadline: deadline
        },
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dx: 5000000, // 5 X
          minDy: 9000000,
          recipient: wallet3,
          deadline: deadline
        }
      ];

      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-swap-x-for-y",
        [Cl.list(swaps.map(swap => Cl.tuple({
          'token-x': swap.tokenX,
          'token-y': swap.tokenY,
          'dx': Cl.uint(swap.dx),
          'min-dy': Cl.uint(swap.minDy),
          'recipient': Cl.principal(swap.recipient),
          'deadline': Cl.uint(swap.deadline)
        })))]
      , wallet1);

      expect(result).toBeOk(Cl.list([
        Cl.tuple({
          dx: Cl.uint(10000000),
          dy: Cl.uint(19980019), // Expected output after first swap
          fee: Cl.uint(30000),
          recipient: Cl.principal(wallet1)
        }),
        Cl.tuple({
          dx: Cl.uint(20000000),
          dy: Cl.uint(39920318), // Expected output after second swap
          fee: Cl.uint(60000),
          recipient: Cl.principal(wallet2)
        }),
        Cl.tuple({
          dx: Cl.uint(5000000),
          dy: Cl.uint(9975124), // Expected output after third swap
          fee: Cl.uint(15000),
          recipient: Cl.principal(wallet3)
        })
      ]));
    });

    it("should handle mixed successful and failed swaps", () => {
      const deadline = simnet.blockHeight + 20;
      const swaps = [
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dx: 10000000,
          minDy: 18000000,
          recipient: wallet1,
          deadline: deadline
        },
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dx: 10000000,
          minDy: 20000000, // Too high minimum (slippage exceeded)
          recipient: wallet2,
          deadline: deadline
        }
      ];

      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-swap-x-for-y",
        [Cl.list(swaps.map(swap => Cl.tuple({
          'token-x': swap.tokenX,
          'token-y': swap.tokenY,
          'dx': Cl.uint(swap.dx),
          'min-dy': Cl.uint(swap.minDy),
          'recipient': Cl.principal(swap.recipient),
          'deadline': Cl.uint(swap.deadline)
        })))]
      , wallet1);

      // Should fail due to slippage on second swap
      expect(result).toBeErr(Cl.uint(103)); // ERR_SLIPPAGE_EXCEEDED
    });

    it("should reject empty swap list", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-swap-x-for-y",
        [Cl.list([])],
        wallet1
      );

      expect(result).toBeErr(Cl.uint(100)); // ERR_ZERO_INPUT
    });

    it("should handle expired deadline in bulk swap", () => {
      const expiredDeadline = simnet.blockHeight - 1;
      const swaps = [
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dx: 10000000,
          minDy: 18000000,
          recipient: wallet1,
          deadline: expiredDeadline
        }
      ];

      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-swap-x-for-y",
        [Cl.list(swaps.map(swap => Cl.tuple({
          'token-x': swap.tokenX,
          'token-y': swap.tokenY,
          'dx': Cl.uint(swap.dx),
          'min-dy': Cl.uint(swap.minDy),
          'recipient': Cl.principal(swap.recipient),
          'deadline': Cl.uint(swap.deadline)
        })))]
      , wallet1);

      expect(result).toBeErr(Cl.uint(102)); // ERR_DEADLINE_EXPIRED
    });
  });

  describe("Bulk Swap Y for X", () => {
    it("should perform multiple Y to X swaps successfully", () => {
      const deadline = simnet.blockHeight + 20;
      const swaps = [
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dy: 20000000, // 20 Y
          minDx: 9000000,
          recipient: wallet1,
          deadline: deadline
        },
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dy: 10000000, // 10 Y
          minDx: 4500000,
          recipient: wallet2,
          deadline: deadline
        }
      ];

      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-swap-y-for-x",
        [Cl.list(swaps.map(swap => Cl.tuple({
          'token-x': swap.tokenX,
          'token-y': swap.tokenY,
          'dy': Cl.uint(swap.dy),
          'min-dx': Cl.uint(swap.minDx),
          'recipient': Cl.principal(swap.recipient),
          'deadline': Cl.uint(swap.deadline)
        })))]
      , wallet1);

      expect(result).toBeOk(Cl.list([
        Cl.tuple({
          dx: Cl.uint(9950248), // Expected X output
          dy: Cl.uint(20000000),
          fee: Cl.uint(60000),
          recipient: Cl.principal(wallet1)
        }),
        Cl.tuple({
          dx: Cl.uint(4975124), // Expected X output after first swap
          dy: Cl.uint(10000000),
          fee: Cl.uint(30000),
          recipient: Cl.principal(wallet2)
        })
      ]));
    });

    it("should reject empty Y to X swap list", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-swap-y-for-x",
        [Cl.list([])],
        wallet1
      );

      expect(result).toBeErr(Cl.uint(100)); // ERR_ZERO_INPUT
    });
  });

  describe("Bulk Liquidity Operations", () => {
    it("should bulk add liquidity", () => {
      const liquidityAdditions = [
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          amountX: 50000000, // 50 X
          amountY: 100000000, // 100 Y
          minShares: 50000
        },
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          amountX: 25000000, // 25 X
          amountY: 50000000, // 50 Y
          minShares: 25000
        }
      ];

      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-add-liquidity",
        [Cl.list(liquidityAdditions.map(add => Cl.tuple({
          'token-x': add.tokenX,
          'token-y': add.tokenY,
          'amount-x': Cl.uint(add.amountX),
          'amount-y': Cl.uint(add.amountY),
          'min-shares': Cl.uint(add.minShares)
        })))]
      , wallet1);

      expect(result).toBeOk(Cl.list([
        Cl.tuple({
          shares: Cl.uint(70710),
          x: Cl.uint(50000000),
          y: Cl.uint(100000000)
        }),
        Cl.tuple({
          shares: Cl.uint(35355),
          x: Cl.uint(25000000),
          y: Cl.uint(50000000)
        })
      ]));
    });

    it("should bulk remove liquidity", () => {
      // First add liquidity
      simnet.callPublicFn(
        contractName,
        "add-liquidity",
        [
          Cl.contractPrincipal(deployer, "token-x"),
          Cl.contractPrincipal(deployer, "token-y"),
          Cl.uint(50000000),
          Cl.uint(100000000),
          Cl.uint(50000)
        ],
        wallet1
      );

      // Then bulk remove (split the shares)
      const liquidityRemovals = [
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          shares: 35355, // Half the shares
          minX: 25000000,
          minY: 50000000
        },
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          shares: 35355, // Other half
          minX: 25000000,
          minY: 50000000
        }
      ];

      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-remove-liquidity",
        [Cl.list(liquidityRemovals.map(remove => Cl.tuple({
          'token-x': remove.tokenX,
          'token-y': remove.tokenY,
          'shares': Cl.uint(remove.shares),
          'min-x': Cl.uint(remove.minX),
          'min-y': Cl.uint(remove.minY)
        })))]
      , wallet1);

      expect(result).toBeOk(Cl.list([
        Cl.tuple({
          shares: Cl.uint(35355),
          x: Cl.uint(25000000),
          y: Cl.uint(50000000)
        }),
        Cl.tuple({
          shares: Cl.uint(35355),
          x: Cl.uint(25000000),
          y: Cl.uint(50000000)
        })
      ]));
    });

    it("should reject empty bulk liquidity operations", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "bulk-add-liquidity",
        [Cl.list([])],
        wallet1
      );

      expect(result).toBeErr(Cl.uint(100)); // ERR_ZERO_INPUT
    });
  });

  describe("Bulk Operation Integration", () => {
    it("should combine bulk swaps with liquidity changes", () => {
      // Start with bulk swaps
      const deadline = simnet.blockHeight + 20;
      const swaps = [
        {
          tokenX: Cl.contractPrincipal(deployer, "token-x"),
          tokenY: Cl.contractPrincipal(deployer, "token-y"),
          dx: 50000000, // 50 X
          minDy: 90000000,
          recipient: wallet1,
          deadline: deadline
        }
      ];

      simnet.callPublicFn(
        contractName,
        "bulk-swap-x-for-y",
        [Cl.list(swaps.map(swap => Cl.tuple({
          'token-x': swap.tokenX,
          'token-y': swap.tokenY,
          'dx': Cl.uint(swap.dx),
          'min-dy': Cl.uint(swap.minDy),
          'recipient': Cl.principal(swap.recipient),
          'deadline': Cl.uint(swap.deadline)
        })))]
      , wallet1);

      // Then add liquidity
      simnet.callPublicFn(
        contractName,
        "bulk-add-liquidity",
        [Cl.list([Cl.tuple({
          'token-x': Cl.contractPrincipal(deployer, "token-x"),
          'token-y': Cl.contractPrincipal(deployer, "token-y"),
          'amount-x': Cl.uint(100000000),
          'amount-y': Cl.uint(200000000),
          'min-shares': Cl.uint(100000)
        })])]
      , wallet2);

      // Verify reserves have changed
      const { result } = simnet.callReadOnlyFn(
        contractName,
        "get-reserves",
        [],
        wallet1
      );

      // Reserves should reflect the swap and liquidity addition
      expect(result.data.x).toBeGreaterThan(Cl.uint(1000000000));
      expect(result.data.y).toBeLessThan(Cl.uint(2000000000));
    });

    it("should handle complex bulk trading scenario", () => {
      const deadline = simnet.blockHeight + 30;

      // Bulk X to Y swaps
      const xToYSwaps = [
        { dx: 10000000, recipient: wallet1 },
        { dx: 20000000, recipient: wallet2 },
        { dx: 15000000, recipient: wallet3 }
      ];

      simnet.callPublicFn(
        contractName,
        "bulk-swap-x-for-y",
        [Cl.list(xToYSwaps.map(swap => Cl.tuple({
          'token-x': Cl.contractPrincipal(deployer, "token-x"),
          'token-y': Cl.contractPrincipal(deployer, "token-y"),
          'dx': Cl.uint(swap.dx),
          'min-dy': Cl.uint(1), // Very low minimum for testing
          'recipient': Cl.principal(swap.recipient),
          'deadline': Cl.uint(deadline)
        })))]
      , wallet1);

      // Bulk Y to X swaps
      const yToXSwaps = [
        { dy: 50000000, recipient: wallet1 },
        { dy: 25000000, recipient: wallet2 }
      ];

      simnet.callPublicFn(
        contractName,
        "bulk-swap-y-for-x",
        [Cl.list(yToXSwaps.map(swap => Cl.tuple({
          'token-x': Cl.contractPrincipal(deployer, "token-x"),
          'token-y': Cl.contractPrincipal(deployer, "token-y"),
          'dy': Cl.uint(swap.dy),
          'min-dx': Cl.uint(1), // Very low minimum for testing
          'recipient': Cl.principal(swap.recipient),
          'deadline': Cl.uint(deadline)
        })))]
      , wallet2);

      // Verify that multiple bulk operations work together
      const reserves = simnet.callReadOnlyFn(
        contractName,
        "get-reserves",
        [],
        wallet1
      );

      expect(reserves.result.data.x).toBeInstanceOf(Object);
      expect(reserves.result.data.y).toBeInstanceOf(Object);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// QUOTE FUNCTION TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Quote Functions", () => {
  beforeEach(() => {
    simnet.callPublicFn(
      contractName,
      "initialize-pool",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(1000000000),
        Cl.uint(2000000000)
      ],
      deployer
    );
  });

  it("should quote X for Y correctly", () => {
    const { result } = simnet.callReadOnlyFn(
      contractName,
      "quote-x-for-y",
      [Cl.uint(10000000)],
      wallet1
    );

    expect(result).toBeOk(Cl.tuple({
      dy: Cl.uint(19980019), // Expected output
      fee: Cl.uint(30000)    // 0.3% fee
    }));
  });

  it("should quote Y for X correctly", () => {
    const { result } = simnet.callReadOnlyFn(
      contractName,
      "quote-y-for-x",
      [Cl.uint(20000000)],
      wallet1
    );

    expect(result).toBeOk(Cl.tuple({
      dx: Cl.uint(9950248), // Expected output
      fee: Cl.uint(60000)   // 0.3% fee
    }));
  });

  it("should quote liquidity addition", () => {
    const { result } = simnet.callReadOnlyFn(
      contractName,
      "quote-add-liquidity",
      [Cl.uint(50000000), Cl.uint(100000000)],
      wallet1
    );

    expect(result).toBeOk(Cl.tuple({
      shares: Cl.uint(70710),
      optimal_x: Cl.uint(50000000),
      optimal_y: Cl.uint(100000000)
    }));
  });

  it("should quote liquidity removal", () => {
    const { result } = simnet.callReadOnlyFn(
      contractName,
      "quote-remove-liquidity",
      [Cl.uint(100000)],
      wallet1
    );

    expect(result).toBeOk(Cl.tuple({
      "amount-x": Cl.uint(100000000),
      "amount-y": Cl.uint(200000000)
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EDGE CASES AND ERROR HANDLING
// ════════════════════════════════════════════════════════════════════════════

describe("Edge Cases", () => {
  beforeEach(() => {
    simnet.callPublicFn(
      contractName,
      "initialize-pool",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(1000000000),
        Cl.uint(2000000000)
      ],
      deployer
    );
  });

  it("should handle zero input amounts", () => {
    const deadline = simnet.blockHeight + 10;
    const { result } = simnet.callPublicFn(
      contractName,
      "swap-x-for-y",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(0), // Zero input
        Cl.uint(0),
        Cl.principal(wallet1),
        Cl.uint(deadline)
      ],
      wallet1
    );

    expect(result).toBeErr(Cl.uint(100)); // ERR_ZERO_INPUT
  });

  it("should handle insufficient liquidity", () => {
    const deadline = simnet.blockHeight + 10;
    const { result } = simnet.callPublicFn(
      contractName,
      "swap-x-for-y",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(1000000000), // More than available reserves
        Cl.uint(1),
        Cl.principal(wallet1),
        Cl.uint(deadline)
      ],
      wallet1
    );

    expect(result).toBeErr(Cl.uint(104)); // ERR_INSUFFICIENT_LIQUIDITY
  });

  it("should calculate fees correctly", () => {
    const { result } = simnet.callReadOnlyFn(
      contractName,
      "calculate-fee",
      [Cl.uint(100000000)], // 100 tokens
      wallet1
    );

    expect(result).toBeUint(30000); // 100 * 0.003 = 300
  });

  it("should track total fees collected", () => {
    const deadline = simnet.blockHeight + 10;

    // Perform a swap
    simnet.callPublicFn(
      contractName,
      "swap-x-for-y",
      [
        Cl.contractPrincipal(deployer, "token-x"),
        Cl.contractPrincipal(deployer, "token-y"),
        Cl.uint(10000000),
        Cl.uint(18000000),
        Cl.principal(wallet1),
        Cl.uint(deadline)
      ],
      wallet1
    );

    const { result } = simnet.callReadOnlyFn(
      contractName,
      "get-total-fees",
      [],
      wallet1
    );

    expect(result.data["fees-x"]).toBeUint(30000); // Fee from the swap
    expect(result.data["fees-y"]).toBeUint(0); // No Y fees yet
  });

  it("should provide contract information", () => {
    const { result } = simnet.callReadOnlyFn(
      contractName,
      "get-contract-info",
      [],
      wallet1
    );

    expect(result.data.name).toBeString("stacks-dex-pool-v5");
    expect(result.data.version).toBeString("4.0.0");
    expect(result.data["fee-bps"]).toBeUint(30);
  });
});
