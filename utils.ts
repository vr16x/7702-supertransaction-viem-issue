import {
  checksumAddress,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeAbiParameters,
  Hash,
  Hex,
  isAddress,
  isHash,
  isHex,
  keccak256,
} from "viem";
import { z } from "zod";
import { concatHex, pad, toHex } from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

export function packUint128Pair(a: bigint | number, b: bigint | number): Hex {
  return concatHex([
    pad(toHex(a), {
      size: 16,
      dir: "left",
    }),
    pad(toHex(b), {
      size: 16,
      dir: "left",
    }),
  ]);
}

export const MEE_SIGNATURE_TYPE_OFFSET = 4;

export interface UserOp extends z.infer<typeof userOpSchema> {}

export type MeeUserOp = z.infer<typeof meeUserOpSchema>;

export interface SignedUserOp extends UserOp {
  signature: Hex;
}

export interface SignedMeeUserOp extends Omit<MeeUserOp, "userOp"> {
  userOp: SignedUserOp;
}

// packed

export interface PackedUserOp
  extends Pick<
    UserOp,
    "sender" | "nonce" | "initCode" | "callData" | "paymasterAndData"
  > {
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
}

export interface PackedMeeUserOp extends Omit<MeeUserOp, "userOp"> {
  userOp: PackedUserOp;
}

export interface SignedPackedUserOp extends PackedUserOp {
  signature: Hex;
}

export interface SignedPackedMeeUserOp extends Omit<MeeUserOp, "userOp"> {
  userOp: SignedPackedUserOp;
}

export function packUserOp(
  userOp: UserOp | SignedUserOp
): PackedUserOp | SignedPackedUserOp {
  const {
    sender,
    nonce,
    initCode,
    callData,
    paymasterAndData,
    preVerificationGas,
    verificationGasLimit,
    callGasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    ...rest
  } = userOp;

  return {
    sender,
    nonce,
    initCode,
    callData,
    accountGasLimits: packUint128Pair(verificationGasLimit, callGasLimit),
    gasFees: packUint128Pair(maxFeePerGas, maxPriorityFeePerGas),
    paymasterAndData,
    preVerificationGas,
    ...rest,
  };
}

export function packMeeUserOp(
  meeUserOp: MeeUserOp | SignedMeeUserOp
): PackedMeeUserOp | SignedPackedMeeUserOp {
  const { userOp, ...rest } = meeUserOp;

  return {
    userOp: packUserOp(userOp),
    ...rest,
  };
}

const getEntryPointV7UserOpHash = (chainId: string, userOpHash: Hash) => {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" }, //
      { type: "address" },
      { type: "uint256" },
    ],
    [
      userOpHash, //
      "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      BigInt(chainId),
    ]
  );

  return keccak256(encoded);
};

const getPackedUserOpHash = (chainId: string, packedUserOp: PackedUserOp) => {
  const {
    sender,
    nonce,
    initCode,
    callData,
    preVerificationGas,
    accountGasLimits,
    gasFees,
    paymasterAndData,
  } = packedUserOp;

  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      sender,
      nonce,
      keccak256(initCode),
      keccak256(callData),
      accountGasLimits,
      preVerificationGas,
      gasFees,
      keccak256(paymasterAndData),
    ]
  );

  return keccak256(encoded);
};

export const createMerkleTree = (packedMeeUserOps: Array<PackedMeeUserOp>) => {
  return StandardMerkleTree.of<[Hash, number, number]>(
    packedMeeUserOps.map((packedMeeUserOp) => {
      const {
        chainId,
        userOp: packedUserOp,
        lowerBoundTimestamp,
        upperBoundTimestamp,
      } = packedMeeUserOp;

      const userOpHash = getEntryPointV7UserOpHash(
        chainId,
        getPackedUserOpHash(chainId, packedUserOp)
      );

      return getMerkleLeaf(
        userOpHash,
        lowerBoundTimestamp,
        upperBoundTimestamp
      );
    }),
    ["bytes32", "uint256", "uint256"],
    { sortLeaves: true }
  );
};

export const getMerkleLeaf = (
  userOpHash: Hash,
  lowerBoundTimestamp: number,
  upperBoundTimestamp: number
): [Hash, number, number] => {
  return [userOpHash, lowerBoundTimestamp, upperBoundTimestamp];
};

export const handleError = (err: unknown) => {
  let revertedError: ContractFunctionRevertedError | undefined;

  if (
    err instanceof ContractFunctionExecutionError &&
    err?.cause instanceof ContractFunctionRevertedError
  ) {
    revertedError = err.cause;
  }

  if (revertedError?.raw) {
    const { args, errorName } = decodeErrorResult({
      abi: entryPointV7,
      data: revertedError.raw,
    });

    switch (errorName) {
      case "FailedOp": {
        const [, message] = args;
        throw new Error(`${errorName}: ${message}`);
      }
    }
  }

  throw err;
};

export const hexSchema = z
  .string()
  .refine((value: string) => isHex(value), "Invalid hex");

export const booleanSchema = z.boolean().describe("Invalid boolean");

export const intLikeSchema = z
  .string()
  .or(z.number())
  .refine(
    (value) => typeof value === "number" || isHex(value) || /^\d+$/.test(value),
    "Invalid int-like"
  )
  .transform((value) => Number(BigInt(value)))
  .refine(
    (value) =>
      value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER,
    "Int-like out of safe integer range"
  );

export const hashSchema = z
  .string()
  .refine((value: string) => isHash(value), "Invalid hash");

export const addressSchema = z
  .string()
  .refine(
    (value: string) => isAddress(value, { strict: false }),
    "Invalid Ethereum address"
  )
  .transform((value) => checksumAddress(value) as Hash);

export const bigIntLikeSchema = z
  .string()
  .or(z.number())
  .or(z.bigint())
  .refine(
    (value) =>
      typeof value === "number" ||
      typeof value === "bigint" ||
      isHex(value) ||
      /^\d+$/.test(value),
    "Invalid bigint-like"
  )
  .transform((value) => BigInt(value));

export const userOpSchema = z.object({
  sender: addressSchema,
  nonce: bigIntLikeSchema,
  initCode: hexSchema.default("0x"),
  callData: hexSchema,
  callGasLimit: bigIntLikeSchema,
  verificationGasLimit: bigIntLikeSchema,
  preVerificationGas: bigIntLikeSchema,
  maxFeePerGas: bigIntLikeSchema,
  maxPriorityFeePerGas: bigIntLikeSchema,
  paymasterAndData: hexSchema,
});

export const eip7702AuthSchema = z.object({
  address: addressSchema,
  chainId: intLikeSchema,
  nonce: intLikeSchema,
  r: hexSchema,
  s: hexSchema,
  yParity: intLikeSchema,
});

export const meeUserOpSchema = z.object({
  userOp: userOpSchema,
  userOpHash: hashSchema,
  meeUserOpHash: hashSchema,
  lowerBoundTimestamp: intLikeSchema,
  upperBoundTimestamp: intLikeSchema,
  maxGasLimit: bigIntLikeSchema,
  maxFeePerGas: bigIntLikeSchema,
  chainId: z.string(),
  eip7702Auth: eip7702AuthSchema.optional(),
  isCleanUpUserOp: booleanSchema.optional(),
});

export const meeEntryPointV7 = [
  {
    inputs: [
      {
        internalType: "contract IEntryPoint",
        name: "_entryPoint",
        type: "address",
      },
    ],
    stateMutability: "payable",
    type: "constructor",
  },
  {
    inputs: [],
    name: "EmptyMessageValue",
    type: "error",
  },
  {
    inputs: [],
    name: "InsufficientBalance",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
    ],
    name: "OwnableInvalidOwner",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
    ],
    name: "OwnableUnauthorizedAccount",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "previousOwner",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "newOwner",
        type: "address",
      },
    ],
    name: "OwnershipTransferred",
    type: "event",
  },
  {
    inputs: [
      {
        internalType: "uint32",
        name: "unstakeDelaySec",
        type: "uint32",
      },
    ],
    name: "addStake",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint256",
        name: "maxGasLimit",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "maxFeePerGas",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "actualGasCost",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "nodeOperatorPremium",
        type: "uint256",
      },
    ],
    name: "calculateRefund",
    outputs: [
      {
        internalType: "uint256",
        name: "refund",
        type: "uint256",
      },
    ],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [],
    name: "deposit",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [],
    name: "entryPoint",
    outputs: [
      {
        internalType: "contract IEntryPoint",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getDeposit",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "sender",
            type: "address",
          },
          {
            internalType: "uint256",
            name: "nonce",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "initCode",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "callData",
            type: "bytes",
          },
          {
            internalType: "bytes32",
            name: "accountGasLimits",
            type: "bytes32",
          },
          {
            internalType: "uint256",
            name: "preVerificationGas",
            type: "uint256",
          },
          {
            internalType: "bytes32",
            name: "gasFees",
            type: "bytes32",
          },
          {
            internalType: "bytes",
            name: "paymasterAndData",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "signature",
            type: "bytes",
          },
        ],
        internalType: "struct PackedUserOperation[]",
        name: "ops",
        type: "tuple[]",
      },
    ],
    name: "handleOps",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "enum IPaymaster.PostOpMode",
        name: "mode",
        type: "uint8",
      },
      {
        internalType: "bytes",
        name: "context",
        type: "bytes",
      },
      {
        internalType: "uint256",
        name: "actualGasCost",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "actualUserOpFeePerGas",
        type: "uint256",
      },
    ],
    name: "postOp",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "sender",
            type: "address",
          },
          {
            internalType: "uint256",
            name: "nonce",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "initCode",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "callData",
            type: "bytes",
          },
          {
            internalType: "bytes32",
            name: "accountGasLimits",
            type: "bytes32",
          },
          {
            internalType: "uint256",
            name: "preVerificationGas",
            type: "uint256",
          },
          {
            internalType: "bytes32",
            name: "gasFees",
            type: "bytes32",
          },
          {
            internalType: "bytes",
            name: "paymasterAndData",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "signature",
            type: "bytes",
          },
        ],
        internalType: "struct PackedUserOperation",
        name: "op",
        type: "tuple",
      },
      {
        internalType: "address",
        name: "target",
        type: "address",
      },
      {
        internalType: "bytes",
        name: "callData",
        type: "bytes",
      },
    ],
    name: "simulateHandleOp",
    outputs: [
      {
        components: [
          {
            internalType: "uint256",
            name: "preOpGas",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "paid",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "accountValidationData",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "paymasterValidationData",
            type: "uint256",
          },
          {
            internalType: "bool",
            name: "targetSuccess",
            type: "bool",
          },
          {
            internalType: "bytes",
            name: "targetResult",
            type: "bytes",
          },
        ],
        internalType: "struct IEntryPointSimulations.ExecutionResult",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "sender",
            type: "address",
          },
          {
            internalType: "uint256",
            name: "nonce",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "initCode",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "callData",
            type: "bytes",
          },
          {
            internalType: "bytes32",
            name: "accountGasLimits",
            type: "bytes32",
          },
          {
            internalType: "uint256",
            name: "preVerificationGas",
            type: "uint256",
          },
          {
            internalType: "bytes32",
            name: "gasFees",
            type: "bytes32",
          },
          {
            internalType: "bytes",
            name: "paymasterAndData",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "signature",
            type: "bytes",
          },
        ],
        internalType: "struct PackedUserOperation",
        name: "op",
        type: "tuple",
      },
    ],
    name: "simulateValidation",
    outputs: [
      {
        components: [
          {
            components: [
              {
                internalType: "uint256",
                name: "preOpGas",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "prefund",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "accountValidationData",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "paymasterValidationData",
                type: "uint256",
              },
              {
                internalType: "bytes",
                name: "paymasterContext",
                type: "bytes",
              },
            ],
            internalType: "struct IEntryPoint.ReturnInfo",
            name: "returnInfo",
            type: "tuple",
          },
          {
            components: [
              {
                internalType: "uint256",
                name: "stake",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "unstakeDelaySec",
                type: "uint256",
              },
            ],
            internalType: "struct IStakeManager.StakeInfo",
            name: "senderInfo",
            type: "tuple",
          },
          {
            components: [
              {
                internalType: "uint256",
                name: "stake",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "unstakeDelaySec",
                type: "uint256",
              },
            ],
            internalType: "struct IStakeManager.StakeInfo",
            name: "factoryInfo",
            type: "tuple",
          },
          {
            components: [
              {
                internalType: "uint256",
                name: "stake",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "unstakeDelaySec",
                type: "uint256",
              },
            ],
            internalType: "struct IStakeManager.StakeInfo",
            name: "paymasterInfo",
            type: "tuple",
          },
          {
            components: [
              {
                internalType: "address",
                name: "aggregator",
                type: "address",
              },
              {
                components: [
                  {
                    internalType: "uint256",
                    name: "stake",
                    type: "uint256",
                  },
                  {
                    internalType: "uint256",
                    name: "unstakeDelaySec",
                    type: "uint256",
                  },
                ],
                internalType: "struct IStakeManager.StakeInfo",
                name: "stakeInfo",
                type: "tuple",
              },
            ],
            internalType: "struct IEntryPoint.AggregatorStakeInfo",
            name: "aggregatorInfo",
            type: "tuple",
          },
        ],
        internalType: "struct IEntryPointSimulations.ValidationResult",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "newOwner",
        type: "address",
      },
    ],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "unlockStake",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "sender",
            type: "address",
          },
          {
            internalType: "uint256",
            name: "nonce",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "initCode",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "callData",
            type: "bytes",
          },
          {
            internalType: "bytes32",
            name: "accountGasLimits",
            type: "bytes32",
          },
          {
            internalType: "uint256",
            name: "preVerificationGas",
            type: "uint256",
          },
          {
            internalType: "bytes32",
            name: "gasFees",
            type: "bytes32",
          },
          {
            internalType: "bytes",
            name: "paymasterAndData",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "signature",
            type: "bytes",
          },
        ],
        internalType: "struct PackedUserOperation",
        name: "userOp",
        type: "tuple",
      },
      {
        internalType: "bytes32",
        name: "userOpHash",
        type: "bytes32",
      },
      {
        internalType: "uint256",
        name: "maxCost",
        type: "uint256",
      },
    ],
    name: "validatePaymasterUserOp",
    outputs: [
      {
        internalType: "bytes",
        name: "context",
        type: "bytes",
      },
      {
        internalType: "uint256",
        name: "validationData",
        type: "uint256",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address payable",
        name: "withdrawAddress",
        type: "address",
      },
    ],
    name: "withdrawStake",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address payable",
        name: "withdrawAddress",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "withdrawTo",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const entryPointV7 = [
  {
    inputs: [],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [
      {
        internalType: "bool",
        name: "success",
        type: "bool",
      },
      {
        internalType: "bytes",
        name: "ret",
        type: "bytes",
      },
    ],
    name: "DelegateAndRevert",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "uint256",
        name: "opIndex",
        type: "uint256",
      },
      {
        internalType: "string",
        name: "reason",
        type: "string",
      },
    ],
    name: "FailedOp",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "uint256",
        name: "opIndex",
        type: "uint256",
      },
      {
        internalType: "string",
        name: "reason",
        type: "string",
      },
      {
        internalType: "bytes",
        name: "inner",
        type: "bytes",
      },
    ],
    name: "FailedOpWithRevert",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidShortString",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "bytes",
        name: "returnData",
        type: "bytes",
      },
    ],
    name: "PostOpReverted",
    type: "error",
  },
  {
    inputs: [],
    name: "ReentrancyGuardReentrantCall",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "sender",
        type: "address",
      },
    ],
    name: "SenderAddressResult",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "aggregator",
        type: "address",
      },
    ],
    name: "SignatureValidationFailed",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "string",
        name: "str",
        type: "string",
      },
    ],
    name: "StringTooLong",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "userOpHash",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "sender",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "factory",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "paymaster",
        type: "address",
      },
    ],
    name: "AccountDeployed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [],
    name: "BeforeExecution",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "totalDeposit",
        type: "uint256",
      },
    ],
    name: "Deposited",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [],
    name: "EIP712DomainChanged",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "userOpHash",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "sender",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "nonce",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "bytes",
        name: "revertReason",
        type: "bytes",
      },
    ],
    name: "PostOpRevertReason",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "aggregator",
        type: "address",
      },
    ],
    name: "SignatureAggregatorChanged",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "totalStaked",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "unstakeDelaySec",
        type: "uint256",
      },
    ],
    name: "StakeLocked",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "withdrawTime",
        type: "uint256",
      },
    ],
    name: "StakeUnlocked",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "withdrawAddress",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "StakeWithdrawn",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "userOpHash",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "sender",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "paymaster",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "nonce",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "bool",
        name: "success",
        type: "bool",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "actualGasCost",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "actualGasUsed",
        type: "uint256",
      },
    ],
    name: "UserOperationEvent",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "userOpHash",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "sender",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "nonce",
        type: "uint256",
      },
    ],
    name: "UserOperationPrefundTooLow",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "userOpHash",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "sender",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "nonce",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "bytes",
        name: "revertReason",
        type: "bytes",
      },
    ],
    name: "UserOperationRevertReason",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "account",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "withdrawAddress",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "Withdrawn",
    type: "event",
  },
  {
    inputs: [
      {
        internalType: "uint32",
        name: "unstakeDelaySec",
        type: "uint32",
      },
    ],
    name: "addStake",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
    ],
    name: "balanceOf",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "target",
        type: "address",
      },
      {
        internalType: "bytes",
        name: "data",
        type: "bytes",
      },
    ],
    name: "delegateAndRevert",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
    ],
    name: "depositTo",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [],
    name: "eip712Domain",
    outputs: [
      {
        internalType: "bytes1",
        name: "fields",
        type: "bytes1",
      },
      {
        internalType: "string",
        name: "name",
        type: "string",
      },
      {
        internalType: "string",
        name: "version",
        type: "string",
      },
      {
        internalType: "uint256",
        name: "chainId",
        type: "uint256",
      },
      {
        internalType: "address",
        name: "verifyingContract",
        type: "address",
      },
      {
        internalType: "bytes32",
        name: "salt",
        type: "bytes32",
      },
      {
        internalType: "uint256[]",
        name: "extensions",
        type: "uint256[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "account",
        type: "address",
      },
    ],
    name: "getDepositInfo",
    outputs: [
      {
        components: [
          {
            internalType: "uint256",
            name: "deposit",
            type: "uint256",
          },
          {
            internalType: "bool",
            name: "staked",
            type: "bool",
          },
          {
            internalType: "uint112",
            name: "stake",
            type: "uint112",
          },
          {
            internalType: "uint32",
            name: "unstakeDelaySec",
            type: "uint32",
          },
          {
            internalType: "uint48",
            name: "withdrawTime",
            type: "uint48",
          },
        ],
        internalType: "struct IStakeManager.DepositInfo",
        name: "info",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getDomainSeparatorV4",
    outputs: [
      {
        internalType: "bytes32",
        name: "",
        type: "bytes32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "sender",
        type: "address",
      },
      {
        internalType: "uint192",
        name: "key",
        type: "uint192",
      },
    ],
    name: "getNonce",
    outputs: [
      {
        internalType: "uint256",
        name: "nonce",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getPackedUserOpTypeHash",
    outputs: [
      {
        internalType: "bytes32",
        name: "",
        type: "bytes32",
      },
    ],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes",
        name: "initCode",
        type: "bytes",
      },
    ],
    name: "getSenderAddress",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "sender",
            type: "address",
          },
          {
            internalType: "uint256",
            name: "nonce",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "initCode",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "callData",
            type: "bytes",
          },
          {
            internalType: "bytes32",
            name: "accountGasLimits",
            type: "bytes32",
          },
          {
            internalType: "uint256",
            name: "preVerificationGas",
            type: "uint256",
          },
          {
            internalType: "bytes32",
            name: "gasFees",
            type: "bytes32",
          },
          {
            internalType: "bytes",
            name: "paymasterAndData",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "signature",
            type: "bytes",
          },
        ],
        internalType: "struct PackedUserOperation",
        name: "userOp",
        type: "tuple",
      },
    ],
    name: "getUserOpHash",
    outputs: [
      {
        internalType: "bytes32",
        name: "",
        type: "bytes32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              {
                internalType: "address",
                name: "sender",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "nonce",
                type: "uint256",
              },
              {
                internalType: "bytes",
                name: "initCode",
                type: "bytes",
              },
              {
                internalType: "bytes",
                name: "callData",
                type: "bytes",
              },
              {
                internalType: "bytes32",
                name: "accountGasLimits",
                type: "bytes32",
              },
              {
                internalType: "uint256",
                name: "preVerificationGas",
                type: "uint256",
              },
              {
                internalType: "bytes32",
                name: "gasFees",
                type: "bytes32",
              },
              {
                internalType: "bytes",
                name: "paymasterAndData",
                type: "bytes",
              },
              {
                internalType: "bytes",
                name: "signature",
                type: "bytes",
              },
            ],
            internalType: "struct PackedUserOperation[]",
            name: "userOps",
            type: "tuple[]",
          },
          {
            internalType: "contract IAggregator",
            name: "aggregator",
            type: "address",
          },
          {
            internalType: "bytes",
            name: "signature",
            type: "bytes",
          },
        ],
        internalType: "struct IEntryPoint.UserOpsPerAggregator[]",
        name: "opsPerAggregator",
        type: "tuple[]",
      },
      {
        internalType: "address payable",
        name: "beneficiary",
        type: "address",
      },
    ],
    name: "handleAggregatedOps",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "sender",
            type: "address",
          },
          {
            internalType: "uint256",
            name: "nonce",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "initCode",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "callData",
            type: "bytes",
          },
          {
            internalType: "bytes32",
            name: "accountGasLimits",
            type: "bytes32",
          },
          {
            internalType: "uint256",
            name: "preVerificationGas",
            type: "uint256",
          },
          {
            internalType: "bytes32",
            name: "gasFees",
            type: "bytes32",
          },
          {
            internalType: "bytes",
            name: "paymasterAndData",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "signature",
            type: "bytes",
          },
        ],
        internalType: "struct PackedUserOperation[]",
        name: "ops",
        type: "tuple[]",
      },
      {
        internalType: "address payable",
        name: "beneficiary",
        type: "address",
      },
    ],
    name: "handleOps",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint192",
        name: "key",
        type: "uint192",
      },
    ],
    name: "incrementNonce",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes",
        name: "callData",
        type: "bytes",
      },
      {
        components: [
          {
            components: [
              {
                internalType: "address",
                name: "sender",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "nonce",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "verificationGasLimit",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "callGasLimit",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "paymasterVerificationGasLimit",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "paymasterPostOpGasLimit",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "preVerificationGas",
                type: "uint256",
              },
              {
                internalType: "address",
                name: "paymaster",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "maxFeePerGas",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "maxPriorityFeePerGas",
                type: "uint256",
              },
            ],
            internalType: "struct EntryPoint.MemoryUserOp",
            name: "mUserOp",
            type: "tuple",
          },
          {
            internalType: "bytes32",
            name: "userOpHash",
            type: "bytes32",
          },
          {
            internalType: "uint256",
            name: "prefund",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "contextOffset",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "preOpGas",
            type: "uint256",
          },
        ],
        internalType: "struct EntryPoint.UserOpInfo",
        name: "opInfo",
        type: "tuple",
      },
      {
        internalType: "bytes",
        name: "context",
        type: "bytes",
      },
    ],
    name: "innerHandleOp",
    outputs: [
      {
        internalType: "uint256",
        name: "actualGasCost",
        type: "uint256",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
      {
        internalType: "uint192",
        name: "",
        type: "uint192",
      },
    ],
    name: "nonceSequenceNumber",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "senderCreator",
    outputs: [
      {
        internalType: "contract ISenderCreator",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes4",
        name: "interfaceId",
        type: "bytes4",
      },
    ],
    name: "supportsInterface",
    outputs: [
      {
        internalType: "bool",
        name: "",
        type: "bool",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "unlockStake",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address payable",
        name: "withdrawAddress",
        type: "address",
      },
    ],
    name: "withdrawStake",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address payable",
        name: "withdrawAddress",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "withdrawAmount",
        type: "uint256",
      },
    ],
    name: "withdrawTo",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    stateMutability: "payable",
    type: "receive",
  },
] as const;

export const DEPLOYED_BYTE_CODE_MAP: Record<string, Hex> = {
  entryPointV7:
    "0x60806040526004361061016d5760003560e01c8063765e827f116100cb578063b760faf91161007f578063c3bce00911610059578063c3bce009146105ac578063dbed18e0146105d9578063fc7e286d146105f957600080fd5b8063b760faf914610564578063bb9fe6bf14610577578063c23a5cea1461058c57600080fd5b8063957122ab116100b0578063957122ab146104f757806397b2dcb9146105175780639b249f691461054457600080fd5b8063765e827f146104b7578063850aaf62146104d757600080fd5b8063205c28781161012257806335567e1a1161010757806335567e1a146102905780635287ce121461032557806370a082311461047457600080fd5b8063205c28781461025057806322cdde4c1461027057600080fd5b80630396cb60116101535780630396cb60146101e55780630bd28e3b146101f85780631b2e01b81461021857600080fd5b806242dc531461018257806301ffc9a7146101b557600080fd5b3661017d5761017b336106cb565b005b600080fd5b34801561018e57600080fd5b506101a261019d36600461426a565b6106ec565b6040519081526020015b60405180910390f35b3480156101c157600080fd5b506101d56101d0366004614330565b6108b7565b60405190151581526020016101ac565b61017b6101f3366004614372565b610a34565b34801561020457600080fd5b5061017b6102133660046143c0565b610dca565b34801561022457600080fd5b506101a26102333660046143db565b600160209081526000928352604080842090915290825290205481565b34801561025c57600080fd5b5061017b61026b366004614410565b610e12565b34801561027c57600080fd5b506101a261028b366004614455565b610fbc565b34801561029c57600080fd5b506101a26102ab3660046143db565b73ffffffffffffffffffffffffffffffffffffffff8216600090815260016020908152604080832077ffffffffffffffffffffffffffffffffffffffffffffffff8516845290915290819020549082901b7fffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000161792915050565b34801561033157600080fd5b5061041261034036600461448a565b6040805160a0810182526000808252602082018190529181018290526060810182905260808101919091525073ffffffffffffffffffffffffffffffffffffffff1660009081526020818152604091829020825160a0810184528154815260019091015460ff811615159282019290925261010082046dffffffffffffffffffffffffffff16928101929092526f01000000000000000000000000000000810463ffffffff166060830152730100000000000000000000000000000000000000900465ffffffffffff16608082015290565b6040516101ac9190600060a082019050825182526020830151151560208301526dffffffffffffffffffffffffffff604084015116604083015263ffffffff606084015116606083015265ffffffffffff608084015116608083015292915050565b34801561048057600080fd5b506101a261048f36600461448a565b73ffffffffffffffffffffffffffffffffffffffff1660009081526020819052604090205490565b3480156104c357600080fd5b5061017b6104d23660046144ec565b610ffe565b3480156104e357600080fd5b5061017b6104f2366004614543565b61117b565b34801561050357600080fd5b5061017b610512366004614598565b611220565b34801561052357600080fd5b5061053761053236600461461d565b611378565b6040516101ac91906146ed565b34801561055057600080fd5b5061017b61055f36600461473c565b6114c4565b61017b61057236600461448a565b6106cb565b34801561058357600080fd5b5061017b6115af565b34801561059857600080fd5b5061017b6105a736600461448a565b61178f565b3480156105b857600080fd5b506105cc6105c7366004614455565b611a7c565b6040516101ac919061477e565b3480156105e557600080fd5b5061017b6105f43660046144ec565b611d80565b34801561060557600080fd5b5061068161061436600461448a565b6000602081905290815260409020805460019091015460ff81169061010081046dffffffffffffffffffffffffffff16906f01000000000000000000000000000000810463ffffffff1690730100000000000000000000000000000000000000900465ffffffffffff1685565b6040805195865293151560208601526dffffffffffffffffffffffffffff9092169284019290925263ffffffff909116606083015265ffffffffffff16608082015260a0016101ac565b60015b60058110156106df576001016106ce565b6106e88261222c565b5050565b6000805a9050333014610760576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601760248201527f4141393220696e7465726e616c2063616c6c206f6e6c7900000000000000000060448201526064015b60405180910390fd5b8451606081015160a082015181016127100160405a603f02816107855761078561485e565b0410156107b6577fdeaddead0000000000000000000000000000000000000000000000000000000060005260206000fd5b8751600090156108575760006107d3846000015160008c86612282565b9050806108555760006107e761080061229a565b80519091501561084f57846000015173ffffffffffffffffffffffffffffffffffffffff168a602001517f1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a20187602001518460405161084692919061488d565b60405180910390a35b60019250505b505b600088608001515a86030190506108a7828a8a8a8080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152508792506122c6915050565b955050505050505b949350505050565b60007fffffffff0000000000000000000000000000000000000000000000000000000082167f60fc6b6e00000000000000000000000000000000000000000000000000000000148061094a57507fffffffff0000000000000000000000000000000000000000000000000000000082167f915074d800000000000000000000000000000000000000000000000000000000145b8061099657507fffffffff0000000000000000000000000000000000000000000000000000000082167fcf28ef9700000000000000000000000000000000000000000000000000000000145b806109e257507fffffffff0000000000000000000000000000000000000000000000000000000082167f3e84f02100000000000000000000000000000000000000000000000000000000145b80610a2e57507f01ffc9a7000000000000000000000000000000000000000000000000000000007fffffffff000000000000000000000000000000000000000000000000000000008316145b92915050565b33600090815260208190526040902063ffffffff8216610ab0576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601a60248201527f6d757374207370656369667920756e7374616b652064656c61790000000000006044820152606401610757565b600181015463ffffffff6f0100000000000000000000000000000090910481169083161015610b3b576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601c60248201527f63616e6e6f7420646563726561736520756e7374616b652074696d65000000006044820152606401610757565b6001810154600090610b6390349061010090046dffffffffffffffffffffffffffff166148d5565b905060008111610bcf576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601260248201527f6e6f207374616b652073706563696669656400000000000000000000000000006044820152606401610757565b6dffffffffffffffffffffffffffff811115610c47576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152600e60248201527f7374616b65206f766572666c6f770000000000000000000000000000000000006044820152606401610757565b6040805160a08101825283548152600160208083018281526dffffffffffffffffffffffffffff86811685870190815263ffffffff8a811660608801818152600060808a0181815233808352828a52918c90209a518b55965199909801805494519151965165ffffffffffff16730100000000000000000000000000000000000000027fffffffffffffff000000000000ffffffffffffffffffffffffffffffffffffff979094166f0100000000000000000000000000000002969096167fffffffffffffff00000000000000000000ffffffffffffffffffffffffffffff91909516610100027fffffffffffffffffffffffffffffffffff0000000000000000000000000000ff991515999099167fffffffffffffffffffffffffffffffffff00000000000000000000000000000090941693909317979097179190911691909117179055835185815290810192909252917fa5ae833d0bb1dcd632d98a8b70973e8516812898e19bf27b70071ebc8dc52c01910160405180910390a2505050565b33600090815260016020908152604080832077ffffffffffffffffffffffffffffffffffffffffffffffff851684529091528120805491610e0a836148e8565b919050555050565b3360009081526020819052604090208054821115610e8c576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601960248201527f576974686472617720616d6f756e7420746f6f206c61726765000000000000006044820152606401610757565b8054610e99908390614920565b81556040805173ffffffffffffffffffffffffffffffffffffffff851681526020810184905233917fd1c19fbcd4551a5edfb66d43d2e337c04837afda3482b42bdf569a8fccdae5fb910160405180910390a260008373ffffffffffffffffffffffffffffffffffffffff168360405160006040518083038185875af1925050503d8060008114610f46576040519150601f19603f3d011682016040523d82523d6000602084013e610f4b565b606091505b5050905080610fb6576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601260248201527f6661696c656420746f20776974686472617700000000000000000000000000006044820152606401610757565b50505050565b6000610fc7826124ee565b6040805160208101929092523090820152466060820152608001604051602081830303815290604052805190602001209050919050565b611006612507565b8160008167ffffffffffffffff81111561102257611022613ffd565b60405190808252806020026020018201604052801561105b57816020015b611048613e51565b8152602001906001900390816110405790505b50905060005b828110156110d457600082828151811061107d5761107d614933565b602002602001015190506000806110b8848a8a878181106110a0576110a0614933565b90506020028101906110b29190614962565b85612548565b915091506110c984838360006127a7565b505050600101611061565b506040516000907fbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972908290a160005b8381101561115e576111528188888481811061112157611121614933565b90506020028101906111339190614962565b85848151811061114557611145614933565b60200260200101516129fc565b90910190600101611103565b506111698482612dd2565b5050506111766001600255565b505050565b6000808473ffffffffffffffffffffffffffffffffffffffff1684846040516111a59291906149a0565b600060405180830381855af49150503d80600081146111e0576040519150601f19603f3d011682016040523d82523d6000602084013e6111e5565b606091505b509150915081816040517f994105540000000000000000000000000000000000000000000000000000000081526004016107579291906149b0565b83158015611243575073ffffffffffffffffffffffffffffffffffffffff83163b155b156112aa576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601960248201527f41413230206163636f756e74206e6f74206465706c6f796564000000000000006044820152606401610757565b6014811061133c5760006112c160148284866149cb565b6112ca916149f5565b60601c9050803b60000361133a576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601b60248201527f41413330207061796d6173746572206e6f74206465706c6f79656400000000006044820152606401610757565b505b6040517f08c379a00000000000000000000000000000000000000000000000000000000081526020600482015260006024820152604401610757565b6113b36040518060c0016040528060008152602001600081526020016000815260200160008152602001600015158152602001606081525090565b6113bb612507565b6113c3613e51565b6113cc86612f19565b6000806113db60008985612548565b9150915060006113ed60008a866129fc565b90506000606073ffffffffffffffffffffffffffffffffffffffff8a161561147f578973ffffffffffffffffffffffffffffffffffffffff1689896040516114369291906149a0565b6000604051808303816000865af19150503d8060008114611473576040519150601f19603f3d011682016040523d82523d6000602084013e611478565b606091505b5090925090505b6040518060c001604052808760800151815260200184815260200186815260200185815260200183151581526020018281525096505050505050506108af6001600255565b60006114e560065473ffffffffffffffffffffffffffffffffffffffff1690565b73ffffffffffffffffffffffffffffffffffffffff1663570e1a3684846040518363ffffffff1660e01b815260040161151f929190614a86565b6020604051808303816000875af115801561153e573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906115629190614a9a565b6040517f6ca7b80600000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff82166004820152909150602401610757565b336000908152602081905260408120600181015490916f0100000000000000000000000000000090910463ffffffff169003611647576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152600a60248201527f6e6f74207374616b6564000000000000000000000000000000000000000000006044820152606401610757565b600181015460ff166116b5576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601160248201527f616c726561647920756e7374616b696e670000000000000000000000000000006044820152606401610757565b60018101546000906116e0906f01000000000000000000000000000000900463ffffffff1642614ab7565b6001830180547fffffffffffffff000000000000ffffffffffffffffffffffffffffffffffff001673010000000000000000000000000000000000000065ffffffffffff84169081027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00169190911790915560405190815290915033907ffa9b3c14cc825c412c9ed81b3ba365a5b459439403f18829e572ed53a4180f0a906020015b60405180910390a25050565b336000908152602081905260409020600181015461010090046dffffffffffffffffffffffffffff168061181f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601460248201527f4e6f207374616b6520746f2077697468647261770000000000000000000000006044820152606401610757565b6001820154730100000000000000000000000000000000000000900465ffffffffffff166118a9576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601d60248201527f6d7573742063616c6c20756e6c6f636b5374616b6528292066697273740000006044820152606401610757565b60018201544273010000000000000000000000000000000000000090910465ffffffffffff161115611937576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601b60248201527f5374616b65207769746864726177616c206973206e6f742064756500000000006044820152606401610757565b6001820180547fffffffffffffff000000000000000000000000000000000000000000000000ff1690556040805173ffffffffffffffffffffffffffffffffffffffff851681526020810183905233917fb7c918e0e249f999e965cafeb6c664271b3f4317d296461500e71da39f0cbda3910160405180910390a260008373ffffffffffffffffffffffffffffffffffffffff168260405160006040518083038185875af1925050503d8060008114611a0c576040519150601f19603f3d011682016040523d82523d6000602084013e611a11565b606091505b5050905080610fb6576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601860248201527f6661696c656420746f207769746864726177207374616b6500000000000000006044820152606401610757565b611a84613f03565b611a8c613e51565b611a9583612f19565b600080611aa460008685612548565b845160e001516040805180820182526000808252602080830182815273ffffffffffffffffffffffffffffffffffffffff95861683528282528483206001908101546dffffffffffffffffffffffffffff6101008083048216885263ffffffff6f010000000000000000000000000000009384900481169095528e51518951808b018b5288815280880189815291909b168852878752898820909401549081049091168952049091169052835180850190945281845283015293955091935090366000611b7460408b018b614add565b909250905060006014821015611b8b576000611ba6565b611b996014600084866149cb565b611ba2916149f5565b60601c5b6040805180820182526000808252602080830182815273ffffffffffffffffffffffffffffffffffffffff86168352908290529290206001015461010081046dffffffffffffffffffffffffffff1682526f01000000000000000000000000000000900463ffffffff169091529091509350505050600085905060006040518060a001604052808960800151815260200189604001518152602001888152602001878152602001611c588a6060015190565b905260408051808201825260035473ffffffffffffffffffffffffffffffffffffffff908116825282518084019093526004548352600554602084810191909152820192909252919250831615801590611cc9575060018373ffffffffffffffffffffffffffffffffffffffff1614155b15611d4d5760408051808201825273ffffffffffffffffffffffffffffffffffffffff851680825282518084018452600080825260208083018281529382528181529490206001015461010081046dffffffffffffffffffffffffffff1682526f01000000000000000000000000000000900463ffffffff16909152909182015290505b6040805160a081018252928352602083019590955293810192909252506060810192909252608082015295945050505050565b611d88612507565b816000805b82811015611f7a5736868683818110611da857611da8614933565b9050602002810190611dba9190614b42565b9050366000611dc98380614b76565b90925090506000611de0604085016020860161448a565b90507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff73ffffffffffffffffffffffffffffffffffffffff821601611e81576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601760248201527f4141393620696e76616c69642061676772656761746f720000000000000000006044820152606401610757565b73ffffffffffffffffffffffffffffffffffffffff811615611f5e5773ffffffffffffffffffffffffffffffffffffffff8116632dd811338484611ec86040890189614add565b6040518563ffffffff1660e01b8152600401611ee79493929190614d2e565b60006040518083038186803b158015611eff57600080fd5b505afa925050508015611f10575060015b611f5e576040517f86a9f75000000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff82166004820152602401610757565b611f6882876148d5565b95505060019093019250611d8d915050565b5060008167ffffffffffffffff811115611f9657611f96613ffd565b604051908082528060200260200182016040528015611fcf57816020015b611fbc613e51565b815260200190600190039081611fb45790505b5090506000805b848110156120ac5736888883818110611ff157611ff1614933565b90506020028101906120039190614b42565b90503660006120128380614b76565b90925090506000612029604085016020860161448a565b90508160005b8181101561209a57600089898151811061204b5761204b614933565b6020026020010151905060008061206e8b8989878181106110a0576110a0614933565b9150915061207e848383896127a7565b8a612088816148e8565b9b50506001909301925061202f915050565b505060019094019350611fd692505050565b506040517fbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f97290600090a150600080805b858110156121e757368989838181106120f7576120f7614933565b90506020028101906121099190614b42565b905061211b604082016020830161448a565b73ffffffffffffffffffffffffffffffffffffffff167f575ff3acadd5ab348fe1855e217e0f3678f8d767d7494c9f9fefbee2e17cca4d60405160405180910390a236600061216a8380614b76565b90925090508060005b818110156121d6576121b58885858481811061219157612191614933565b90506020028101906121a39190614962565b8b8b8151811061114557611145614933565b6121bf90886148d5565b9650876121cb816148e8565b985050600101612173565b5050600190930192506120dc915050565b506040516000907f575ff3acadd5ab348fe1855e217e0f3678f8d767d7494c9f9fefbee2e17cca4d908290a261221d8682612dd2565b50505050506111766001600255565b60006122388234613107565b90508173ffffffffffffffffffffffffffffffffffffffff167f2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c48260405161178391815260200190565b6000806000845160208601878987f195945050505050565b60603d828111156122a85750815b604051602082018101604052818152816000602083013e9392505050565b6000805a8551909150600090816122dc82613147565b60e083015190915073ffffffffffffffffffffffffffffffffffffffff81166123085782519350612403565b80935060008851111561240357868202955060028a600281111561232e5761232e614de5565b146124035760a08301516040517f7c627b2100000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff831691637c627b2191612390908e908d908c908990600401614e14565b600060405180830381600088803b1580156123aa57600080fd5b5087f1935050505080156123bc575060015b6124035760006123cd61080061229a565b9050806040517fad7954bc0000000000000000000000000000000000000000000000000000000081526004016107579190614e77565b5a60a0840151606085015160808c015192880399909901980190880380821115612436576064600a828403020498909801975b505060408901518783029650868110156124ab5760028b600281111561245e5761245e614de5565b036124815780965061246f8a613171565b61247c8a6000898b6131cd565b6124e0565b7fdeadaa510000000000000000000000000000000000000000000000000000000060005260206000fd5b8681036124b88682613107565b506000808d60028111156124ce576124ce614de5565b1490506124dd8c828b8d6131cd565b50505b505050505050949350505050565b60006124f982613255565b805190602001209050919050565b6002805403612542576040517f3ee5aeb500000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60028055565b60008060005a845190915061255d868261331a565b61256686610fbc565b6020860152604081015161012082015161010083015160a08401516080850151606086015160c0870151861717171717176effffffffffffffffffffffffffffff811115612610576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601860248201527f41413934206761732076616c756573206f766572666c6f7700000000000000006044820152606401610757565b600061263f8460c081015160a08201516080830151606084015160408501516101009095015194010101010290565b905061264e8a8a8a8487613465565b9650612662846000015185602001516136a6565b6126d157896040517f220266b6000000000000000000000000000000000000000000000000000000008152600401610757918152604060208201819052601a908201527f4141323520696e76616c6964206163636f756e74206e6f6e6365000000000000606082015260800190565b825a8603111561274657896040517f220266b6000000000000000000000000000000000000000000000000000000008152600401610757918152604060208201819052601e908201527f41413236206f76657220766572696669636174696f6e4761734c696d69740000606082015260800190565b60e084015160609073ffffffffffffffffffffffffffffffffffffffff161561277a576127758b8b8b85613701565b975090505b604089018290528060608a015260a08a01355a870301896080018181525050505050505050935093915050565b6000806127b385613958565b915091508173ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff161461285557856040517f220266b60000000000000000000000000000000000000000000000000000000081526004016107579181526040602082018190526014908201527f41413234207369676e6174757265206572726f72000000000000000000000000606082015260800190565b80156128c657856040517f220266b60000000000000000000000000000000000000000000000000000000081526004016107579181526040602082018190526017908201527f414132322065787069726564206f72206e6f7420647565000000000000000000606082015260800190565b60006128d185613958565b9250905073ffffffffffffffffffffffffffffffffffffffff81161561295c57866040517f220266b60000000000000000000000000000000000000000000000000000000081526004016107579181526040602082018190526014908201527f41413334207369676e6174757265206572726f72000000000000000000000000606082015260800190565b81156129f357866040517f220266b60000000000000000000000000000000000000000000000000000000081526004016107579181526040602082018190526021908201527f41413332207061796d61737465722065787069726564206f72206e6f7420647560608201527f6500000000000000000000000000000000000000000000000000000000000000608082015260a00190565b50505050505050565b6000805a90506000612a0f846060015190565b6040519091506000903682612a2760608a018a614add565b9150915060606000826003811115612a3e57843591505b507f72288ed1000000000000000000000000000000000000000000000000000000007fffffffff00000000000000000000000000000000000000000000000000000000821601612b7e5760008b8b60200151604051602401612aa1929190614e8a565b604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff167f8dd7712f000000000000000000000000000000000000000000000000000000001790525190915030906242dc5390612b349084908f908d90602401614f70565b604051602081830303815290604052915060e01b6020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff8381831617835250505050925050612bf5565b3073ffffffffffffffffffffffffffffffffffffffff166242dc5385858d8b604051602401612bb09493929190614fb0565b604051602081830303815290604052915060e01b6020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff838183161783525050505091505b602060008351602085016000305af19550600051985084604052505050505080612dc85760003d80602003612c305760206000803e60005191505b507fdeaddead000000000000000000000000000000000000000000000000000000008103612cc357876040517f220266b6000000000000000000000000000000000000000000000000000000008152600401610757918152604060208201819052600f908201527f41413935206f7574206f66206761730000000000000000000000000000000000606082015260800190565b7fdeadaa51000000000000000000000000000000000000000000000000000000008103612d2d57600086608001515a612cfc9087614920565b612d0691906148d5565b6040880151909150612d1788613171565b612d2488600083856131cd565b9550612dc69050565b8551805160208089015192015173ffffffffffffffffffffffffffffffffffffffff90911691907ff62676f440ff169a3a9afdbf812e89e7f95975ee8e5c31214ffdef631c5f479290612d8161080061229a565b604051612d8f92919061488d565b60405180910390a3600086608001515a612da99087614920565b612db391906148d5565b9050612dc260028886846122c6565b9550505b505b5050509392505050565b73ffffffffffffffffffffffffffffffffffffffff8216612e4f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601860248201527f4141393020696e76616c69642062656e656669636961727900000000000000006044820152606401610757565b60008273ffffffffffffffffffffffffffffffffffffffff168260405160006040518083038185875af1925050503d8060008114612ea9576040519150601f19603f3d011682016040523d82523d6000602084013e612eae565b606091505b5050905080611176576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601f60248201527f41413931206661696c65642073656e6420746f2062656e6566696369617279006044820152606401610757565b6130196040517fd69400000000000000000000000000000000000000000000000000000000000060208201527fffffffffffffffffffffffffffffffffffffffff0000000000000000000000003060601b1660228201527f01000000000000000000000000000000000000000000000000000000000000006036820152600090603701604080518083037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe00181529190528051602090910120600680547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff90921691909117905550565b3063957122ab61302c6040840184614add565b613039602086018661448a565b61304660e0870187614add565b6040518663ffffffff1660e01b8152600401613066959493929190614fe7565b60006040518083038186803b15801561307e57600080fd5b505afa92505050801561308f575060015b6131045761309b615036565b806308c379a0036130f857506130af615052565b806130ba57506130fa565b8051156106e8576000816040517f220266b600000000000000000000000000000000000000000000000000000000815260040161075792919061488d565b505b3d6000803e3d6000fd5b50565b73ffffffffffffffffffffffffffffffffffffffff821660009081526020819052604081208054829061313b9085906148d5565b91829055509392505050565b61010081015161012082015160009190808203613165575092915050565b6108af824883016139ab565b805180516020808401519281015160405190815273ffffffffffffffffffffffffffffffffffffffff90921692917f67b4fa9642f42120bf031f3051d1824b0fe25627945b27b8a6a65d5761d5482e910160405180910390a350565b835160e0810151815160208088015193015160405173ffffffffffffffffffffffffffffffffffffffff9384169492909316927f49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f916132479189908990899093845291151560208401526040830152606082015260800190565b60405180910390a450505050565b60608135602083013560006132756132706040870187614add565b6139c3565b905060006132896132706060880188614add565b9050608086013560a087013560c088013560006132ac61327060e08c018c614add565b6040805173ffffffffffffffffffffffffffffffffffffffff9a909a1660208b015289810198909852606089019690965250608087019390935260a086019190915260c085015260e08401526101008084019190915281518084039091018152610120909201905292915050565b613327602083018361448a565b73ffffffffffffffffffffffffffffffffffffffff168152602082810135908201526fffffffffffffffffffffffffffffffff6080808401358281166060850152811c604084015260a084013560c0808501919091528401359182166101008401521c6101208201523660006133a060e0850185614add565b9092509050801561344a576034811015613416576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601d60248201527f4141393320696e76616c6964207061796d6173746572416e64446174610000006044820152606401610757565b61342082826139d6565b60a0860152608085015273ffffffffffffffffffffffffffffffffffffffff1660e0840152610fb6565b600060e084018190526080840181905260a084015250505050565b8251805160009190613484888761347f60408b018b614add565b613a47565b60e0820151600073ffffffffffffffffffffffffffffffffffffffff82166134e25773ffffffffffffffffffffffffffffffffffffffff83166000908152602081905260409020548781116134db578088036134de565b60005b9150505b60208801516040517f19822f7c00000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff8516916319822f7c91899161353e918e919087906004016150fa565b60206040518083038160008887f193505050508015613598575060408051601f3d9081017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01682019092526135959181019061511f565b60015b6135dc57896135a861080061229a565b6040517f65c8fd4d000000000000000000000000000000000000000000000000000000008152600401610757929190615138565b945073ffffffffffffffffffffffffffffffffffffffff82166136995773ffffffffffffffffffffffffffffffffffffffff83166000908152602081905260409020805480891115613693578b6040517f220266b60000000000000000000000000000000000000000000000000000000081526004016107579181526040602082018190526017908201527f41413231206469646e2774207061792070726566756e64000000000000000000606082015260800190565b88900390555b5050505095945050505050565b73ffffffffffffffffffffffffffffffffffffffff8216600090815260016020908152604080832084821c808552925282208054849167ffffffffffffffff83169190856136f3836148e8565b909155501495945050505050565b60606000805a855160e081015173ffffffffffffffffffffffffffffffffffffffff8116600090815260208190526040902080549394509192909190878110156137b0578a6040517f220266b6000000000000000000000000000000000000000000000000000000008152600401610757918152604060208201819052601e908201527f41413331207061796d6173746572206465706f73697420746f6f206c6f770000606082015260800190565b87810382600001819055506000846080015190508373ffffffffffffffffffffffffffffffffffffffff166352b7512c828d8d602001518d6040518563ffffffff1660e01b8152600401613806939291906150fa565b60006040518083038160008887f19350505050801561386557506040513d6000823e601f3d9081017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01682016040526138629190810190615185565b60015b6138a9578b61387561080061229a565b6040517f65c8fd4d000000000000000000000000000000000000000000000000000000008152600401610757929190615211565b9098509650805a87031115613949578b6040517f220266b60000000000000000000000000000000000000000000000000000000081526004016107579181526040602082018190526027908201527f41413336206f766572207061796d6173746572566572696669636174696f6e4760608201527f61734c696d697400000000000000000000000000000000000000000000000000608082015260a00190565b50505050505094509492505050565b6000808260000361396e57506000928392509050565b600061397984613dd3565b9050806040015165ffffffffffff164211806139a05750806020015165ffffffffffff1642105b905194909350915050565b60008183106139ba57816139bc565b825b9392505050565b6000604051828085833790209392505050565b600080806139e760148286886149cb565b6139f0916149f5565b60601c613a016024601487896149cb565b613a0a9161525e565b60801c613a1b60346024888a6149cb565b613a249161525e565b9194506fffffffffffffffffffffffffffffffff16925060801c90509250925092565b8015610fb65782515173ffffffffffffffffffffffffffffffffffffffff81163b15613ad857846040517f220266b6000000000000000000000000000000000000000000000000000000008152600401610757918152604060208201819052601f908201527f414131302073656e64657220616c726561647920636f6e737472756374656400606082015260800190565b6000613af960065473ffffffffffffffffffffffffffffffffffffffff1690565b73ffffffffffffffffffffffffffffffffffffffff1663570e1a3686600001516040015186866040518463ffffffff1660e01b8152600401613b3c929190614a86565b60206040518083038160008887f1158015613b5b573d6000803e3d6000fd5b50505050506040513d601f19601f82011682018060405250810190613b809190614a9a565b905073ffffffffffffffffffffffffffffffffffffffff8116613c0857856040517f220266b6000000000000000000000000000000000000000000000000000000008152600401610757918152604060208201819052601b908201527f4141313320696e6974436f6465206661696c6564206f72204f4f470000000000606082015260800190565b8173ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614613ca557856040517f220266b600000000000000000000000000000000000000000000000000000000815260040161075791815260406020808301829052908201527f4141313420696e6974436f6465206d7573742072657475726e2073656e646572606082015260800190565b8073ffffffffffffffffffffffffffffffffffffffff163b600003613d2e57856040517f220266b600000000000000000000000000000000000000000000000000000000815260040161075791815260406020808301829052908201527f4141313520696e6974436f6465206d757374206372656174652073656e646572606082015260800190565b6000613d3d60148286886149cb565b613d46916149f5565b60601c90508273ffffffffffffffffffffffffffffffffffffffff1686602001517fd51a9c61267aa6196961883ecf5ff2da6619c37dac0fa92122513fb32c032d2d83896000015160e00151604051613dc292919073ffffffffffffffffffffffffffffffffffffffff92831681529116602082015260400190565b60405180910390a350505050505050565b60408051606081018252600080825260208201819052918101919091528160a081901c65ffffffffffff8116600003613e0f575065ffffffffffff5b6040805160608101825273ffffffffffffffffffffffffffffffffffffffff909316835260d09490941c602083015265ffffffffffff16928101929092525090565b6040518060a00160405280613ede604051806101400160405280600073ffffffffffffffffffffffffffffffffffffffff168152602001600081526020016000815260200160008152602001600081526020016000815260200160008152602001600073ffffffffffffffffffffffffffffffffffffffff16815260200160008152602001600081525090565b8152602001600080191681526020016000815260200160008152602001600081525090565b6040518060a00160405280613f406040518060a0016040528060008152602001600081526020016000815260200160008152602001606081525090565b8152602001613f62604051806040016040528060008152602001600081525090565b8152602001613f84604051806040016040528060008152602001600081525090565b8152602001613fa6604051806040016040528060008152602001600081525090565b8152602001613fb3613fb8565b905290565b6040518060400160405280600073ffffffffffffffffffffffffffffffffffffffff168152602001613fb3604051806040016040528060008152602001600081525090565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b60a0810181811067ffffffffffffffff8211171561404c5761404c613ffd565b60405250565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f830116810181811067ffffffffffffffff8211171561409657614096613ffd565b6040525050565b604051610140810167ffffffffffffffff811182821017156140c1576140c1613ffd565b60405290565b600067ffffffffffffffff8211156140e1576140e1613ffd565b50601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01660200190565b73ffffffffffffffffffffffffffffffffffffffff8116811461310457600080fd5b803561413a8161410d565b919050565b60008183036101c081121561415357600080fd5b60405161415f8161402c565b8092506101408083121561417257600080fd5b61417a61409d565b92506141858561412f565b83526020850135602084015260408501356040840152606085013560608401526080850135608084015260a085013560a084015260c085013560c08401526141cf60e0860161412f565b60e084015261010085810135908401526101208086013590840152918152908301356020820152610160830135604082015261018083013560608201526101a090920135608090920191909152919050565b60008083601f84011261423357600080fd5b50813567ffffffffffffffff81111561424b57600080fd5b60208301915083602082850101111561426357600080fd5b9250929050565b600080600080610200858703121561428157600080fd5b843567ffffffffffffffff8082111561429957600080fd5b818701915087601f8301126142ad57600080fd5b81356142b8816140c7565b6040516142c58282614052565b8281528a60208487010111156142da57600080fd5b82602086016020830137600060208483010152809850505050614300886020890161413f565b94506101e087013591508082111561431757600080fd5b5061432487828801614221565b95989497509550505050565b60006020828403121561434257600080fd5b81357fffffffff00000000000000000000000000000000000000000000000000000000811681146139bc57600080fd5b60006020828403121561438457600080fd5b813563ffffffff811681146139bc57600080fd5b803577ffffffffffffffffffffffffffffffffffffffffffffffff8116811461413a57600080fd5b6000602082840312156143d257600080fd5b6139bc82614398565b600080604083850312156143ee57600080fd5b82356143f98161410d565b915061440760208401614398565b90509250929050565b6000806040838503121561442357600080fd5b823561442e8161410d565b946020939093013593505050565b6000610120828403121561444f57600080fd5b50919050565b60006020828403121561446757600080fd5b813567ffffffffffffffff81111561447e57600080fd5b6108af8482850161443c565b60006020828403121561449c57600080fd5b81356139bc8161410d565b60008083601f8401126144b957600080fd5b50813567ffffffffffffffff8111156144d157600080fd5b6020830191508360208260051b850101111561426357600080fd5b60008060006040848603121561450157600080fd5b833567ffffffffffffffff81111561451857600080fd5b614524868287016144a7565b90945092505060208401356145388161410d565b809150509250925092565b60008060006040848603121561455857600080fd5b83356145638161410d565b9250602084013567ffffffffffffffff81111561457f57600080fd5b61458b86828701614221565b9497909650939450505050565b6000806000806000606086880312156145b057600080fd5b853567ffffffffffffffff808211156145c857600080fd5b6145d489838a01614221565b9097509550602088013591506145e98261410d565b909350604087013590808211156145ff57600080fd5b5061460c88828901614221565b969995985093965092949392505050565b6000806000806060858703121561463357600080fd5b843567ffffffffffffffff8082111561464b57600080fd5b6146578883890161443c565b9550602087013591506146698261410d565b9093506040860135908082111561431757600080fd5b60005b8381101561469a578181015183820152602001614682565b50506000910152565b600081518084526146bb81602086016020860161467f565b601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0169290920160200192915050565b60208152815160208201526020820151604082015260408201516060820152606082015160808201526080820151151560a0820152600060a083015160c0808401526108af60e08401826146a3565b6000806020838503121561474f57600080fd5b823567ffffffffffffffff81111561476657600080fd5b61477285828601614221565b90969095509350505050565b602080825282516101408383015280516101608401529081015161018083015260408101516101a083015260608101516101c08301526080015160a06101e08301526000906147d16102008401826146a3565b905060208401516147ef604085018280518252602090810151910152565b506040840151805160808581019190915260209182015160a08601526060860151805160c087015282015160e0860152850151805173ffffffffffffffffffffffffffffffffffffffff1661010086015280820151805161012087015290910151610140850152509392505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601260045260246000fd5b8281526040602082015260006108af60408301846146a3565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b80820180821115610a2e57610a2e6148a6565b60007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203614919576149196148a6565b5060010190565b81810381811115610a2e57610a2e6148a6565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600082357ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffee183360301811261499657600080fd5b9190910192915050565b8183823760009101908152919050565b82151581526040602082015260006108af60408301846146a3565b600080858511156149db57600080fd5b838611156149e857600080fd5b5050820193919092039150565b7fffffffffffffffffffffffffffffffffffffffff0000000000000000000000008135818116916014851015614a355780818660140360031b1b83161692505b505092915050565b8183528181602085013750600060208284010152600060207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f840116840101905092915050565b6020815260006108af602083018486614a3d565b600060208284031215614aac57600080fd5b81516139bc8161410d565b65ffffffffffff818116838216019080821115614ad657614ad66148a6565b5092915050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112614b1257600080fd5b83018035915067ffffffffffffffff821115614b2d57600080fd5b60200191503681900382131561426357600080fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa183360301811261499657600080fd5b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112614bab57600080fd5b83018035915067ffffffffffffffff821115614bc657600080fd5b6020019150600581901b360382131561426357600080fd5b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112614c1357600080fd5b830160208101925035905067ffffffffffffffff811115614c3357600080fd5b80360382131561426357600080fd5b6000610120614c6e84614c548561412f565b73ffffffffffffffffffffffffffffffffffffffff169052565b60208301356020850152614c856040840184614bde565b826040870152614c988387018284614a3d565b92505050614ca96060840184614bde565b8583036060870152614cbc838284614a3d565b925050506080830135608085015260a083013560a085015260c083013560c0850152614ceb60e0840184614bde565b85830360e0870152614cfe838284614a3d565b92505050610100614d1181850185614bde565b86840383880152614d23848284614a3d565b979650505050505050565b6040808252810184905260006060600586901b830181019083018783805b89811015614dce577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa087860301845282357ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffee18c3603018112614dac578283fd5b614db8868d8301614c42565b9550506020938401939290920191600101614d4c565b505050508281036020840152614d23818587614a3d565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602160045260246000fd5b600060038610614e4d577f4e487b7100000000000000000000000000000000000000000000000000000000600052602160045260246000fd5b85825260806020830152614e6460808301866146a3565b6040830194909452506060015292915050565b6020815260006139bc60208301846146a3565b604081526000614e9d6040830185614c42565b90508260208301529392505050565b8051805173ffffffffffffffffffffffffffffffffffffffff1683526020810151602084015260408101516040840152606081015160608401526080810151608084015260a081015160a084015260c081015160c084015260e0810151614f2b60e085018273ffffffffffffffffffffffffffffffffffffffff169052565b5061010081810151908401526101209081015190830152602081015161014083015260408101516101608301526060810151610180830152608001516101a090910152565b6000610200808352614f84818401876146a3565b9050614f936020840186614eac565b8281036101e0840152614fa681856146a3565b9695505050505050565b6000610200808352614fc58184018789614a3d565b9050614fd46020840186614eac565b8281036101e0840152614d2381856146a3565b606081526000614ffb606083018789614a3d565b73ffffffffffffffffffffffffffffffffffffffff86166020840152828103604084015261502a818587614a3d565b98975050505050505050565b600060033d111561504f5760046000803e5060005160e01c5b90565b600060443d10156150605790565b6040517ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc803d016004833e81513d67ffffffffffffffff81602484011181841117156150ae57505050505090565b82850191508151818111156150c65750505050505090565b843d87010160208285010111156150e05750505050505090565b6150ef60208286010187614052565b509095945050505050565b60608152600061510d6060830186614c42565b60208301949094525060400152919050565b60006020828403121561513157600080fd5b5051919050565b82815260606020820152600d60608201527f4141323320726576657274656400000000000000000000000000000000000000608082015260a0604082015260006108af60a08301846146a3565b6000806040838503121561519857600080fd5b825167ffffffffffffffff8111156151af57600080fd5b8301601f810185136151c057600080fd5b80516151cb816140c7565b6040516151d88282614052565b8281528760208486010111156151ed57600080fd5b6151fe83602083016020870161467f565b6020969096015195979596505050505050565b82815260606020820152600d60608201527f4141333320726576657274656400000000000000000000000000000000000000608082015260a0604082015260006108af60a08301846146a3565b7fffffffffffffffffffffffffffffffff000000000000000000000000000000008135818116916010851015614a355760109490940360031b84901b169092169291505056fea2646970667358221220da6235a9fed490e0598819f695bb128f935391fa9c8ba963180dfb5cab452aef64736f6c63430008170033",
};
