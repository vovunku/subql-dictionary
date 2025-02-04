import {Bytes} from '@polkadot/types';
const EMPTY_ADDRESS = '0x0000000000000000000000000000000000000000';
import {TransactionV2, EthTransaction ,AccountId, Address, EvmLog} from "@polkadot/types/interfaces"
import {SubstrateExtrinsic,SubstrateBlock,SubstrateEvent} from "@subql/types";
import {
  SpecVersion,
  Event,
  Extrinsic,
  EvmTransaction,
  ContractEmitted,
  ContractsCall,
  EvmLog as EvmLogModel
} from "../types";
import FrontierEvmDatasourcePlugin, { FrontierEvmCall } from "@subql/frontier-evm-processor/";
import {inputToFunctionSighash, isZero, getSelector, wrapExtrinsics, wrapEvents} from "../utils";
import {ApiPromise} from "@polkadot/api";


let specVersion: SpecVersion;

export type ContractEmittedResult = [AccountId, Bytes]

export async function handleBlock(block: SubstrateBlock): Promise<void> {
  if (!specVersion) {
    specVersion = await SpecVersion.get(block.specVersion.toString());
  }
  if(!specVersion || specVersion.id !== block.specVersion.toString()){
    specVersion = new SpecVersion(block.specVersion.toString());
    specVersion.blockHeight = block.block.header.number.toBigInt();
    await specVersion.save();
  }
  const wrappedCalls = wrapExtrinsics(block);
  const wrappedEvents = wrapEvents(wrappedCalls,block.events.filter(
      (evt) =>
          !(evt.event.section === "system" &&
              evt.event.method === "ExtrinsicSuccess")
  ),block)
  let events=[]
  let contractEmittedEvents=[];
  let evmLogs=[];
  wrappedEvents.filter(evt => evt.event.section!=='system' && evt.event.method!=='ExtrinsicSuccess').map(event=>{
    events.push(handleEvent(event))
    if (event.event.section === 'contracts' && (event.event.method === 'ContractEmitted' || event.event.method === 'ContractExecution')) {
      contractEmittedEvents.push(handleContractsEmitted(event));
    }
    if(event.event.section === 'evm' && event.event.method === 'Log'){
      evmLogs.push(handleEvmEvent(event));
    }
  })

  let calls=[]
  let contractCalls=[];
  let evmTransactions=[];

  wrappedCalls.map(async call => {
    calls.push(handleCall(call))
    if (call.extrinsic.method.section === 'contracts' && call.extrinsic.method.method === 'call') {
      contractCalls.push(handleContractCalls(call));
    }
    try {
      if (call.extrinsic.method.section === 'ethereum' && call.extrinsic.method.method === 'transact') {
        const [frontierEvmCall] = await FrontierEvmDatasourcePlugin.handlerProcessors['substrate/FrontierEvmCall'].transformer({
          input: call as SubstrateExtrinsic<[TransactionV2 | EthTransaction]>,
          ds: {} as any,
          filter: undefined,
          api: api as ApiPromise
        })
        evmTransactions.push(handleEvmTransaction(call.idx.toString(),frontierEvmCall))
      }
    } catch {
      // Failed evm transaction skipped
    }
  })
  // seems there is a concurrent limitation for promise.all and bulkCreate work together,
  // the last entity upsertion are missed
  // We will put them into two promise for now.
  await Promise.all([
    store.bulkCreate('Event', events),
    store.bulkCreate('ContractEmitted', contractEmittedEvents),
    store.bulkCreate('EvmLog', evmLogs),
  ]);
  await Promise.all([
    store.bulkCreate('Extrinsic', calls),
    store.bulkCreate('ContractsCall', contractCalls),
    store.bulkCreate('EvmTransaction', evmTransactions)
  ]);
}

export function handleEvent(event: SubstrateEvent): Event {
  return Event.create({
    id: `${event.block.block.header.number.toString()}-${event.idx}`,
    blockHeight: event.block.block.header.number.toBigInt(),
    module: event.event.section,
    event: event.event.method,
  });
}

export function handleCall(extrinsic: SubstrateExtrinsic): Extrinsic {
  return Extrinsic.create({
    id: `${extrinsic.block.block.header.number.toString()}-${extrinsic.idx.toString()}`,
    module: extrinsic.extrinsic.method.section,
    call: extrinsic.extrinsic.method.method,
    blockHeight: extrinsic.block.block.header.number.toBigInt(),
    success: extrinsic.success,
    isSigned: extrinsic.extrinsic.isSigned,
  });
}

function handleEvmEvent(event: SubstrateEvent): EvmLogModel {
  let address;
  // let data;
  let topics;
  const [log] = event.event.data as unknown as [{log:EvmLog} | EvmLog]

  if((log as EvmLog).address){
    address = (log as EvmLog).address
    topics = (log as EvmLog).topics
  }else{
    address = (log as {log: EvmLog}).log.address;
    topics = (log as {log: EvmLog}).log.topics;
  }
  return EvmLogModel.create({
    id: `${event.block.block.header.number.toString()}-${event.idx}`,
    address: address.toString(),
    blockHeight:event.block.block.header.number.toBigInt(),
    topics0:topics[0].toHex().toLowerCase(),
    topics1:topics[1]?.toHex().toLowerCase(),
    topics2:topics[2]?.toHex().toLowerCase(),
    topics3:topics[3]?.toHex().toLowerCase(),
  });
}

export function handleEvmTransaction(idx: string, tx: FrontierEvmCall): EvmTransaction {
  if (!tx.hash) {
    return;
  }
  const func = isZero(tx.data) ? undefined : inputToFunctionSighash(tx.data).toLowerCase();
  return EvmTransaction.create({
    id: `${tx.blockNumber.toString()}-${idx}`,
    txHash: tx.hash,
    from: tx.from.toLowerCase(),
    to:tx.to.toLowerCase(),
    func: func,
    blockHeight: BigInt(tx.blockNumber.toString()),
    success: tx.success,
  });
}

export function handleContractCalls(call:  SubstrateExtrinsic): ContractsCall {
  const [dest,,,, data] = call.extrinsic.method.args;
  const contractCall = new ContractsCall(`${call.block.block.header.number.toString()}-${call.idx}`)
  contractCall.from = call.extrinsic.isSigned? call.extrinsic.signer.toString(): undefined;
  contractCall.success = !call.events.find(
      (evt) => evt.event.section === 'system' && evt.event.method === 'ExtrinsicFailed'
  );
  contractCall.dest = (dest as Address).toString();
  contractCall.blockHeight = call.block.block.header.number.toBigInt();
  contractCall.selector = getSelector(data.toU8a())
  return contractCall;

}

export function handleContractsEmitted(event: SubstrateEvent):ContractEmitted{
  const [contract, data] = event.event.data as unknown as ContractEmittedResult;

  const contractEmitted = ContractEmitted.create({
    id: `${event.block.block.header.number.toString()}-${event.idx}`,
    blockHeight:  event.block.block.header.number.toBigInt(),
    contract: contract.toString(),
    from: event.extrinsic.extrinsic.isSigned? event.extrinsic.extrinsic.signer.toString(): EMPTY_ADDRESS,
    eventIndex: data[0],
  });

  return contractEmitted;
}
