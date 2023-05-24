import { Account, randomSecp256k1Account } from "./utils";
import { parseUnit } from "@ckb-lumos/bi"
import { TransactionSkeleton, TransactionSkeletonType } from "@ckb-lumos/helpers";
import { initializeConfig } from "@ckb-lumos/config-manager/lib";
import { Cell } from "@ckb-lumos/base";
import { INDEXER_URL, addOutputs, execTx, localConfig } from "./lib";
import { createDepGroup, deployCode, updatedLocalConfig } from "./deploy_scripts";
import { ckb_soft_cap_per_deposit, depositPhaseOne, depositPhaseTwo } from "./ickb_domain_logic";
import { RPC } from "@ckb-lumos/rpc";

async function main() {
    console.log("Initializing Config with devnet data");
    initializeConfig(await localConfig());
    console.log("✓");

    // Genesis account.
    let genesisAccount = randomSecp256k1Account("0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc");

    console.log("Creating new test account:");
    let account = randomSecp256k1Account();
    console.log(account)
    console.log("✓");

    console.log("Funding test account");
    const _ = await execTx(fundAccount(account), genesisAccount)
    console.log("✓");

    console.log("Deploying iCKB code");
    const dataFiles = ["./files/sudt", "./files/ickb_domain_logic", "./files/ckb_sudt_limit_order"];
    const deployCodeOutpoints = await execTx(await deployCode(dataFiles), account)
    console.log("✓");

    console.log("Creating iCKB DepGroup");
    const depGroupOutpoints = await execTx(await createDepGroup(deployCodeOutpoints["code"]), account);
    console.log("✓");

    console.log("Updating Config with iCKB DepGroup");
    initializeConfig(await updatedLocalConfig(dataFiles, depGroupOutpoints["depGroup"][0]));
    console.log("✓");

    console.log("Creating a deposit phase one");
    const header = await new RPC(INDEXER_URL, { timeout: 10000 }).getTipHeader();
    const depositPhaseOneOutpoints = await execTx(await depositPhaseOne(ckb_soft_cap_per_deposit(header), 61, account), account);
    console.log("✓");

    console.log("Creating a deposit phase two");
    const depositPhaseTwoOutpoints = await execTx(await depositPhaseTwo(depositPhaseOneOutpoints["receipt"], depositPhaseOneOutpoints["ownerLock"][0]), account);
    console.log("✓");

    console.log("iCKB SUDT token at: ", depositPhaseTwoOutpoints["ickbSudt"]);
}

function fundAccount(account: Account, transaction_?: TransactionSkeletonType) {
    let transaction = transaction_ ?? TransactionSkeleton();

    // Create cells for the funding address.
    const output1: Cell = {
        cellOutput: {
            capacity: parseUnit("100000", "ckb").toHexString(),
            lock: account.lockScript,
            type: undefined
        },
        data: "0x"
    };

    transaction = addOutputs(transaction, "funding", ...Array.from({ length: 100 }, () => output1));

    return transaction
}

main();