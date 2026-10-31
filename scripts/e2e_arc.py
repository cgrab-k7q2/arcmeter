"""End-to-end ArcMeter run on Arc (testnet by default).

Deploys ArcMeter (or reuses ARCMETER address), opens a channel from the payer to a demo
service wallet, signs 3 off-chain vouchers (= 3 "API calls"), verifies them off-chain,
has the service claim the latest one and close the channel (refunding the rest).

Usage: python scripts/e2e_arc.py [--network testnet|mainnet] [--deposit-usdc 1.0] [--price-usdc 0.01]
Secrets are read from files and never printed.
"""
import argparse, json, os, sys, time
from web3 import Web3
from web3.logs import DISCARD
from eth_account import Account
from eth_account.messages import encode_typed_data

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FARM = os.path.abspath(os.path.join(ROOT, '..', '..'))
sys.path.insert(0, FARM)
from common import load_acct, log, send  # noqa: E402

NETS = {
    'testnet': dict(rpc='https://rpc.testnet.arc.io', chain=5042002, explorer='https://explorer.testnet.arc.io'),
    'mainnet': dict(rpc='https://rpc.mainnet.arc.io', chain=5042, explorer='https://explorer.arc.io'),
}
USDC = Web3.to_checksum_address('0x3600000000000000000000000000000000000000')  # Arc USDC ERC-20 interface (6 dp)
ERC20 = [
    {"name": "approve", "type": "function", "stateMutability": "nonpayable", "inputs": [{"type": "address"}, {"type": "uint256"}], "outputs": [{"type": "bool"}]},
    {"name": "balanceOf", "type": "function", "stateMutability": "view", "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
    {"name": "allowance", "type": "function", "stateMutability": "view", "inputs": [{"type": "address"}, {"type": "address"}], "outputs": [{"type": "uint256"}]},
]


def artifact():
    with open(os.path.join(ROOT, 'contracts/out/ArcMeter.sol/ArcMeter.json')) as f:
        a = json.load(f)
    return a['abi'], a['bytecode']['object']


def service_account():
    """Demo 'service' (payee) wallet, generated once, stored 0600 next to the farm wallet."""
    p = os.path.join(FARM, 'arcmeter-demo-service.json')
    if not os.path.exists(p):
        acct = Account.create()
        with open(p, 'w') as f:
            json.dump({'address': acct.address, 'private_key': acct.key.hex()}, f)
        os.chmod(p, 0o600)
    with open(p) as f:
        return Account.from_key(json.load(f)['private_key'])


def sign_voucher(acct, chain_id, meter, channel_id, cumulative):
    typed = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
            "Voucher": [{"name": "channelId", "type": "bytes32"}, {"name": "cumulativeAmount", "type": "uint256"}],
        },
        "primaryType": "Voucher",
        "domain": {"name": "ArcMeter", "version": "1", "chainId": chain_id, "verifyingContract": meter},
        "message": {"channelId": channel_id, "cumulativeAmount": cumulative},
    }
    return acct.sign_message(encode_typed_data(full_message=typed)).signature


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--network', default='testnet', choices=NETS)
    ap.add_argument('--deposit-usdc', type=float, default=1.0)
    ap.add_argument('--price-usdc', type=float, default=0.01)
    ap.add_argument('--service-gas-usdc', type=float, default=0.05)
    ap.add_argument('--keep-open', action='store_true', help='open a channel and stop (for the examples/)')
    ap.add_argument('--meter', default=os.environ.get('ARCMETER'))
    a = ap.parse_args()
    net = NETS[a.network]
    w3 = Web3(Web3.HTTPProvider(net['rpc'], request_kwargs={'timeout': 30}))
    assert w3.eth.chain_id == net['chain']
    payer, svc = load_acct(), service_account()
    usdc = w3.eth.contract(address=USDC, abi=ERC20)
    abi, bytecode = artifact()
    out = {'network': a.network, 'payer': payer.address, 'service': svc.address, 'txs': {}}

    gas_cost = [0]

    def tx(name, acct, built):
        h, r = send(w3, acct, built, min_fee_gwei=21)
        gas_cost[0] += r.gasUsed * r.effectiveGasPrice
        assert r.status == 1, f'{name} reverted: {h}'
        out['txs'][name] = h
        log(f'arcmeter {a.network} {name} {h} gas={r.gasUsed}')
        return r

    if a.meter:
        meter_addr = Web3.to_checksum_address(a.meter)
    else:
        C = w3.eth.contract(abi=abi, bytecode=bytecode)
        r = tx('deploy', payer, C.constructor(USDC).build_transaction({'from': payer.address}))
        meter_addr = r.contractAddress
    out['meter'] = meter_addr
    meter = w3.eth.contract(address=meter_addr, abi=abi)

    deposit = int(a.deposit_usdc * 1e6)
    price = int(a.price_usdc * 1e6)
    # service needs a little gas (gas is USDC on Arc) to claim/close
    if w3.eth.get_balance(svc.address) < w3.to_wei(a.service_gas_usdc / 2, 'ether'):
        tx('fund_service_gas', payer, {'to': svc.address, 'value': w3.to_wei(a.service_gas_usdc, 'ether')})
    if usdc.functions.allowance(payer.address, meter_addr).call() < deposit:
        tx('approve', payer, usdc.functions.approve(meter_addr, deposit).build_transaction({'from': payer.address}))
    expires = w3.eth.get_block('latest').timestamp + 3600
    r = tx('open', payer, meter.functions.open(svc.address, deposit, expires).build_transaction({'from': payer.address}))
    ev = meter.events.ChannelOpened().process_receipt(r, errors=DISCARD)[0]
    cid = ev['args']['id']
    out['channelId'] = '0x' + cid.hex()

    if a.keep_open:
        print(json.dumps(out, indent=2)); return

    # three metered "API calls": payer signs cumulative vouchers, service verifies off-chain
    vouchers = []
    for n in range(1, 4):
        cum = price * n
        sig = sign_voucher(payer, net['chain'], meter_addr, cid, cum)
        ok, amt = meter.functions.redeemable(cid, cum, sig).call()
        assert ok and amt == cum, ('voucher not redeemable', n)
        assert meter.functions.voucherDigest(cid, cum).call() is not None
        vouchers.append((cum, sig))
    out['offchain_vouchers_verified'] = len(vouchers)

    cum, sig = vouchers[-1]
    r = tx('claim', svc, meter.functions.claim(cid, cum, sig).build_transaction({'from': svc.address}))
    paid = meter.events.Claimed().process_receipt(r, errors=DISCARD)[0]['args']['amount']
    assert paid == cum
    out['service_received_usdc'] = paid / 1e6
    r = tx('close', svc, meter.functions.close(cid, 0, b'').build_transaction({'from': svc.address}))
    out['refunded_to_payer_usdc'] = meter.events.ChannelClosed().process_receipt(r, errors=DISCARD)[0]['args']['refundedToPayer'] / 1e6
    out['total_gas_cost_usdc'] = round(gas_cost[0] / 1e18, 6)
    out['explorer'] = f"{net['explorer']}/address/{meter_addr}"
    print(json.dumps(out, indent=2))
    with open(os.path.join(ROOT, f'deployments.{a.network}.json'), 'w') as f:
        json.dump(out, f, indent=2)


if __name__ == '__main__':
    main()
