import {
  createMeeClient,
  signQuote,
  toMultichainNexusAccount,
} from "@biconomy/abstractjs";
import {
  Address,
  concatHex,
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  fromHex,
  Hex,
  http,
  pad,
  parseEther,
  SignAuthorizationReturnType,
  slice,
  sliceHex,
  toHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  createMerkleTree,
  DEPLOYED_BYTE_CODE_MAP,
  eip7702AuthSchema,
  entryPointV7 as EV7_ABI,
  handleError,
  MEE_SIGNATURE_TYPE_OFFSET,
  meeUserOpSchema,
  meeEntryPointV7 as MEPV7_ABI,
  packMeeUserOp,
  SignedPackedMeeUserOp,
} from "./utils";
import { ethers } from "ethers";

const meeEntryPointV7 = {
  address: "0xE854C84cD68fC434cB3B0042c29235D452cAD977" as Address,
  abi: MEPV7_ABI,
};

const entryPointV7 = {
  address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address,
  abi: EV7_ABI,
  code: DEPLOYED_BYTE_CODE_MAP.entryPointV7,
};

const handleOpsDeposit = parseEther("0.03");

// Set the private key here
const PK: string | null = null;

// Set the rpc url here
const rpc: string | null = null;

if (!PK) {
  throw new Error("Private key not set");
}

if (!rpc) {
  throw new Error("RPC url not set");
}

const account = privateKeyToAccount(PK as Hex);

const mcNexus = await toMultichainNexusAccount({
  chains: [baseSepolia],
  signer: account,
  transports: [http()],
  accountAddress: account.address,
});

const meeClient = await createMeeClient({
  account: mcNexus,
});

const get7702UserOp = async () => {
  const quote = await meeClient.getQuote({
    delegate: true,
    instructions: [
      {
        calls: [
          {
            to: zeroAddress,
            value: 1n,
          },
        ],
        chainId: baseSepolia.id,
      },
    ],
    feeToken: {
      address: zeroAddress, // usdc
      chainId: baseSepolia.id,
    },
  });

  const signedQuote = await signQuote(meeClient, { quote });

  const signatureType = sliceHex(
    signedQuote.signature,
    0,
    MEE_SIGNATURE_TYPE_OFFSET
  );
  const signatureData = sliceHex(
    signedQuote.signature,
    MEE_SIGNATURE_TYPE_OFFSET
  );

  const { userOps, hash } = signedQuote;

  const packedMeeUserOps = userOps.map((meeUserOp) =>
    packMeeUserOp(meeUserOpSchema.parse(meeUserOp))
  );

  const merkleTree = createMerkleTree(packedMeeUserOps);
  const proof = merkleTree.getProof(0) as Hex[];

  const packedMeeUserOp = meeUserOpSchema.parse(userOps[0]);

  const signature = concatHex([
    signatureType,
    encodeAbiParameters(
      [
        { type: "bytes32" }, //
        { type: "uint48" },
        { type: "uint48" },
        { type: "bytes32[]" },
        { type: "bytes" },
      ],
      [
        hash, //
        packedMeeUserOp.lowerBoundTimestamp,
        packedMeeUserOp.upperBoundTimestamp,
        proof,
        signatureData,
      ]
    ),
  ]);

  return {
    ...packedMeeUserOp,
    userOp: {
      ...packedMeeUserOp.userOp,
      signature,
    },
  };
};

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpc as string),
});

const executeViemSimulation = async (
  packedMeeUserOp: SignedPackedMeeUserOp
) => {
  try {
    const authorizationList: SignAuthorizationReturnType[] = [];

    if (packedMeeUserOp.eip7702Auth) {
      const auth = eip7702AuthSchema.parse(packedMeeUserOp.eip7702Auth);
      authorizationList.push(auth);
    }

    const { result } = await publicClient.simulateContract({
      address: meeEntryPointV7.address,
      abi: meeEntryPointV7.abi,
      value: handleOpsDeposit,
      functionName: "simulateHandleOp",
      args: [{ ...packedMeeUserOp.userOp }, zeroAddress, "0x"],
      authorizationList,
      blockTag: "latest",
      account: "0x845cD903BcB7f9aeF67925cAb73E2DC8c3101C40",
      stateOverride: [
        { address: entryPointV7.address, code: entryPointV7.code },
      ],
    });

    return result;
  } catch (err) {
    handleError(err);
  }
};

const executeEthersSimulation = async (
  packedMeeUserOp: SignedPackedMeeUserOp
) => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpc as string);

    const calldata = encodeFunctionData({
      abi: meeEntryPointV7.abi,
      functionName: "simulateHandleOp",
      args: [packedMeeUserOp.userOp, zeroAddress, "0x"],
    });

    const value = ethers.utils.hexStripZeros(
      ethers.utils.hexlify(ethers.BigNumber.from(handleOpsDeposit))
    );

    let tx: any = {
      to: meeEntryPointV7.address,
      value: value,
      data: calldata,
      from: "0x845cD903BcB7f9aeF67925cAb73E2DC8c3101C40",
    };

    if (packedMeeUserOp.eip7702Auth) {
      tx = {
        ...tx,
        authorizationList: [packedMeeUserOp.eip7702Auth],
      };
    }

    const stateOverride = {
      [entryPointV7.address]: {
        code: entryPointV7.code,
      },
    };

    const simulationResult = await provider.send("eth_call", [
      tx,
      "latest",
      stateOverride,
    ]);

    const result = decodeFunctionResult({
      abi: meeEntryPointV7.abi,
      functionName: "simulateHandleOp",
      data: simulationResult,
    });

    return result;
  } catch (err) {
    handleError(err);
  }
};

const meeUserOp = await get7702UserOp();
const packedMeeUserOp = packMeeUserOp(meeUserOp) as SignedPackedMeeUserOp;

// Toggle the code execution here to see the ethers vs viem simulation
// const result = await executeViemSimulation(packedMeeUserOp); // This doesn't works
const result = await executeEthersSimulation(packedMeeUserOp); // This works

if (!result) {
  throw new Error("Failed to fetch simulation result");
}

const validationData = pad(toHex(result.accountValidationData), {
  size: 32,
});

const sigFailed = fromHex(slice(validationData, 12), "number");

console.log({ sigFailed: sigFailed !== 0 });
