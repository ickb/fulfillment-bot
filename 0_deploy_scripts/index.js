"use strict";

import fs from "fs";
import { utils } from "@ckb-lumos/base";
const { ckbHash } = utils;
import { initializeConfig } from "@ckb-lumos/config-manager";
import { addressToScript, sealTransaction, TransactionSkeleton } from "@ckb-lumos/helpers";
import { Indexer } from "@ckb-lumos/ckb-indexer";
import { addDefaultCellDeps, addDefaultWitnessPlaceholders, collectCapacity, indexerReady, readFileToHexString, readFileToHexStringSync, sendTransaction, signTransaction, waitForTransactionConfirmation } from "../lib/index.js";
import { ckbytesToShannons, hexToArrayBuffer, hexToInt, intToHex } from "../lib/util.js";
import { describeTransaction, initializeLab } from "../lumos_template/lab.js";

// CKB Node and CKB Indexer Node JSON RPC URLs.
const NODE_URL = "http://127.0.0.1:8114/";
const INDEXER_URL = "http://127.0.0.1:8114/";

// This is the private key and address which will be used.
const PRIVATE_KEY_1 = "0x67842f5e4fa0edb34c9b4adbe8c3c1f3c737941f7c875d18bc6ec2f80554111d";
const ADDRESS_1 = "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqvc32wruaxqnk4hdj8yr4yp5u056dkhwtc94sy8q";

// This is the TX fee amount that will be paid in Shannons.
const TX_FEE = 200_000n;

async function deployCode(indexer) {
	console.log("DEPLOY CODE\n");

	// Create a transaction skeleton.
	let transaction = TransactionSkeleton();

	// Add the cell dep for the lock script.
	transaction = addDefaultCellDeps(transaction);

	// Create cells with data from the specified files.
	let outputCapacityTmp = 0n;
	const data_files = ["../files/sudt", "../files/ickb_domain_logic", "../files/ckb_sudt_limit_order"];
	for (const data_file_1 of data_files) {
		const { hexString: hexString1, dataSize: dataSize1 } = await readFileToHexString(data_file_1);
		const outputCapacity1 = ckbytesToShannons(61n) + ckbytesToShannons(dataSize1);
		outputCapacityTmp += outputCapacity1;
		const output1 = {
			cellOutput: {
				capacity: intToHex(outputCapacity1),
				lock: {
					codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
					hashType: "type",
					args: "0x" //Prevent garbage collection by setupCells in initializeLab call////////////////////////
				},
				type: null
			},
			data: hexString1
		};
		transaction = transaction.update("outputs", (i) => i.push(output1));
	}

	// Add input capacity cells.
	const collectedCells = await collectCapacity(indexer, addressToScript(ADDRESS_1), outputCapacityTmp + ckbytesToShannons(61n) + TX_FEE);
	transaction = transaction.update("inputs", (i) => i.concat(collectedCells.inputCells));

	// Determine the capacity of all input cells.
	const inputCapacity = transaction.inputs.toArray().reduce((a, c) => a + hexToInt(c.cellOutput.capacity), 0n);
	const outputCapacity = transaction.outputs.toArray().reduce((a, c) => a + hexToInt(c.cellOutput.capacity), 0n);

	// Create a change Cell for the remaining CKBytes.
	const changeCapacity = intToHex(inputCapacity - outputCapacity - TX_FEE);
	let change = { cellOutput: { capacity: changeCapacity, lock: addressToScript(ADDRESS_1), type: null }, data: "0x" };
	transaction = transaction.update("outputs", (i) => i.push(change));

	// Add in the witness placeholders.
	transaction = addDefaultWitnessPlaceholders(transaction);

	// Print the details of the transaction to the console.
	describeTransaction(transaction.toJS());

	// Sign the transaction.
	const signedTx = signTransaction(transaction, PRIVATE_KEY_1);

	// Send the transaction to the RPC node.
	const txid = await sendTransaction(NODE_URL, signedTx);
	console.log(`Transaction Sent: ${txid}\n`);

	// Wait for the transaction to confirm.
	await waitForTransactionConfirmation(NODE_URL, txid);
	console.log("\n");

	const outPoints = data_files.map(function (path, i) {
		return {
			path: path,
			tx_hash: txid,
			index: intToHex(i)
		};
	});

	return outPoints;
}

async function readStdinAsync() {
	return new Promise((resolve, reject) => {
		let content = '';
		process.stdin.on('data', (buf) => { content += buf.toString(); });
		process.stdin.on('end', () => { resolve(content) });
		process.stdin.on('error', (err) => reject(err));
		process.stdin.resume();
	});
}

async function main() {
	if (process.stdin.isTTY) {
		throw new Error(['Error: no list-hashes data detected in input stream.',
			'The correct use is the following:',
			'(cd ~/ckb && ckb list-hashes --format json) | (cd 0_deploy_scripts && node index.js)\n',
		].join('\n'));
	}

	const listHashes = JSON.parse(await readStdinAsync());

	const config = {
		"PREFIX": "ckt",
		"SCRIPTS": {
			"SECP256K1_BLAKE160": {
				"CODE_HASH": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
				"HASH_TYPE": "type",
				"TX_HASH": "0x0000000000000000000000000000000000000000000000000000000000000000",
				"INDEX": "0x0",
				"DEP_TYPE": "depGroup",
				"SHORT_ID": 0
			},
			"SECP256K1_BLAKE160_MULTISIG": {
				"CODE_HASH": "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8",
				"HASH_TYPE": "type",
				"TX_HASH": "0x0000000000000000000000000000000000000000000000000000000000000000",
				"INDEX": "0x1",
				"DEP_TYPE": "depGroup",
				"SHORT_ID": 1
			},
			"DAO": {
				"CODE_HASH": "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
				"HASH_TYPE": "type",
				"TX_HASH": "0x0000000000000000000000000000000000000000000000000000000000000000",
				"INDEX": "0x2",
				"DEP_TYPE": "code"
			}
		}
	};

	const secp256k1_blake160 = config.SCRIPTS.SECP256K1_BLAKE160;
	const secp256k1_blake160_multisig = config.SCRIPTS.SECP256K1_BLAKE160_MULTISIG;
	const dao = config.SCRIPTS.DAO;
	const system_cells = listHashes.ckb_dev.system_cells;
	const dep_groups = listHashes.ckb_dev.dep_groups;

	let obj = dep_groups.find((o) => o.included_cells.toString() === [
		"Bundled(specs/cells/secp256k1_data)",
		"Bundled(specs/cells/secp256k1_blake160_sighash_all)"
	].toString());
	secp256k1_blake160.TX_HASH = obj.tx_hash;
	secp256k1_blake160.INDEX = intToHex(obj.index);

	obj = dep_groups.find((o) => o.included_cells.toString() === [
		"Bundled(specs/cells/secp256k1_data)",
		"Bundled(specs/cells/secp256k1_blake160_multisig_all)"
	].toString());
	secp256k1_blake160_multisig.TX_HASH = obj.tx_hash;
	secp256k1_blake160_multisig.INDEX = intToHex(obj.index);

	obj = system_cells.find((o) => o.path === "Bundled(specs/cells/dao)");
	dao.TX_HASH = obj.tx_hash;
	dao.INDEX = intToHex(obj.index);

	initializeConfig(config);

	// Initialize an Indexer instance.
	const indexer = new Indexer(INDEXER_URL, NODE_URL);

	// Initialize our lab.
	await initializeLab(NODE_URL, indexer);
	await indexerReady(indexer);

	// Create a cell that contains the binaries.

	const scriptOutPoints = await deployCode(indexer);
	await indexerReady(indexer);

	const ickb_scripts = {}
	for (const s of scriptOutPoints) {
		ickb_scripts[s.path.replace("../files/", "").toUpperCase()] = {
			CODE_HASH: ckbHash(hexToArrayBuffer(readFileToHexStringSync(s.path).hexString)),
			HASH_TYPE: "data",
			TX_HASH: s.tx_hash,
			INDEX: s.index,
			DEP_TYPE: "code"
		}
	}

	const fullConfig = {
		"PREFIX": config.PREFIX,
		"SCRIPTS": { ...config.SCRIPTS, ...ickb_scripts }
	}

	console.log("Config.json initialized to:")
	console.log(fullConfig)

	fs.writeFileSync("../config.json", JSON.stringify(fullConfig, null, 2))

	console.log("Execution completed successfully!");
}
main();
