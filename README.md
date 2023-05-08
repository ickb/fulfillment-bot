# iCKB v1 bot demo

## Setup

### Environment Setup

0. Install `Git`
1. Install `Node.js 16 LTS`
2. Download latest [`ckb (Portable)`](https://github.com/nervosnetwork/ckb/releases/latest), tested with `ckb 0.109.0`
3. Extract the `ckb` compressed folder and renamed it to `~/ckb`

### Devchain configuration

This is section takes material from both [Nervos devchain guide](https://docs.nervos.org/docs/basics/guides/devchain/) and [Ian instructions](https://talk.nervos.org/t/is-there-any-way-to-speed-up-the-blockchain-in-a-way-that-180-epochs-happen-in-a-reasonable-time-frame-in-the-local-devchain/7163).

From within `~/ckb`:

1. Init devchain:

```bash
ckb init --chain dev
```

2. In the `ckb.toml` file under the `[block_assembler]` section set:

```toml
[block_assembler]
code_hash = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8"
args = "0xc8328aabcd9b9e8e64fbc566c4385c3bdeb219d7" # ckt1...gwga account
hash_type = "type"
message = "0x"
```

3. In the `ckb.toml` file under the `[block_assembler]` section set:

```toml
[logger]
filter = "info,ckb-script=debug"# instead "info"
# Other parameters...
```

4. In the `specs/dev.toml` file under the `[params]` section set:

``` toml
[params]
# Other parameters...
epoch_duration_target = 2 # instead of 14400
genesis_epoch_length = 2 # instead of 1000
permanent_difficulty_in_dummy = true
```

5. In the `miner-ckb.toml` file under the `[[miner.workers]]` section set:

``` toml
[[miner.workers]]
# Other parameters...
value = 200 # instead of 5000
```

6. In a new terminal start ckb node and miner:

```bash
(trap 'kill -INT 0' SIGINT; cd ~/ckb/; ckb run --indexer & sleep 1 && ckb miner)
```

7. Create Private Key Files:

``` bash
echo 0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc > pk1
echo 0x63d86723e08f0f813a36ce6aa123bb2289d90680ae1e99d4de8cdb334553f24d > pk2
```

8. Import the Private Keys:

``` bash
ckb-cli account import --privkey-path pk1
```

``` bash
ckb-cli account import --privkey-path pk2
```

### Configure project with local devchain

1. Download this repo in a folder of your choice:  

```bash
git clone https://github.com/ickb/v1-bot-demo.git
```

2. Enter into the repo:

```bash
cd v1-bot-demo
```

3. Populate config.json and deploy scripts on devnet:

```bash
(cd ~/ckb && ckb list-hashes --format json) | (cd 0_deploy_scripts && node index.js)
```
