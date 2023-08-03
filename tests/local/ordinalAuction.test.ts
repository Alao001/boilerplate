import { OrdinalAuction } from '../../src/contracts/ordinalAuction'
import {
    bsv,
    ByteString,
    findSig,
    hash160,
    int2ByteString,
    MethodCallOptions,
    PubKey,
    reverseByteString,
    Sig,
    toByteString,
    toHex,
    Utils,
    UTXO,
} from 'scrypt-ts'
import { expect } from 'chai'
import { getDummySigner, getDummyUTXO, randomPrivateKey } from '../utils/helper'
import { randomBytes } from 'crypto'

describe('Test SmartContract `OrdinalAuction`', () => {
    const [privateKeyAuctioneer, publicKeyAuctioneer, , addressAuctioneer] =
        randomPrivateKey()
    const [, publicKeyNewBidder, , addressNewBidder] = randomPrivateKey()

    const auctionDeadline = Math.round(new Date('2020-01-03').valueOf() / 1000)

    const ordinalUTXO: UTXO = {
        txId: randomBytes(32).toString('hex'),
        outputIndex: 0,
        script: Utils.buildPublicKeyHashScript(
            hash160(publicKeyAuctioneer.toHex())
        ),
        satoshis: 1,
    }

    const ordinalPrevout: ByteString =
        reverseByteString(toByteString(ordinalUTXO.txId), 32n) +
        int2ByteString(BigInt(ordinalUTXO.outputIndex), 4n)

    let auction: OrdinalAuction

    before(async () => {
        await OrdinalAuction.compile()

        auction = new OrdinalAuction(
            ordinalPrevout,
            PubKey(toHex(publicKeyAuctioneer)),
            BigInt(auctionDeadline)
        )

        auction.bindTxBuilder('bid', OrdinalAuction.bidTxBuilder)

        await auction.connect(getDummySigner(privateKeyAuctioneer))
    })

    it('should pass whole auction', async () => {
        let balance = 1
        let currentInstance = auction

        // Perform bidding.
        for (let i = 0; i < 3; i++) {
            const highestBidder = PubKey(toHex(publicKeyNewBidder))
            const bid = BigInt(balance + 100)

            const nextInstance = currentInstance.next()
            nextInstance.bidder = highestBidder

            const contractTx = await currentInstance.methods.bid(
                highestBidder,
                bid,
                {
                    fromUTXO: getDummyUTXO(balance),
                    changeAddress: addressNewBidder,
                    next: {
                        instance: nextInstance,
                        balance: Number(bid),
                    },
                } as MethodCallOptions<OrdinalAuction>
            )

            const result = contractTx.tx.verifyScript(contractTx.atInputIndex)
            expect(result.success, result.error).to.eq(true)

            balance += Number(bid)
            currentInstance = nextInstance
        }

        const fromUTXO = getDummyUTXO(balance)

        // Close the auction.
        currentInstance.bindTxBuilder(
            'close',
            async (
                current: OrdinalAuction,
                options: MethodCallOptions<OrdinalAuction>,
                sigAuctioneer: Sig,
                prevouts: ByteString
            ) => {
                const unsignedTx: bsv.Transaction = new bsv.Transaction()

                // add input that unlocks ordinal UTXO
                unsignedTx
                    .addInput(
                        new bsv.Transaction.Input({
                            prevTxId: ordinalUTXO.txId,
                            outputIndex: ordinalUTXO.outputIndex,
                            script: bsv.Script.fromHex('00'.repeat(34)),
                        }),
                        bsv.Script.fromHex(ordinalUTXO.script),
                        ordinalUTXO.satoshis
                    )
                    .addInput(current.buildContractInput(options.fromUTXO))

                //// Add all fee inputs here as well.
                //.from(feeUTXO)

                // build ordinal destination output
                unsignedTx
                    .addOutput(
                        new bsv.Transaction.Output({
                            script: bsv.Script.fromHex(
                                Utils.buildPublicKeyHashScript(
                                    hash160(current.bidder)
                                )
                            ),
                            satoshis: 1,
                        })
                    )
                    // build auctioneer payment output
                    .addOutput(
                        new bsv.Transaction.Output({
                            script: bsv.Script.fromHex(
                                Utils.buildPublicKeyHashScript(
                                    hash160(current.auctioneer)
                                )
                            ),
                            satoshis: current.utxo.satoshis,
                        })
                    )

                if (options.changeAddress) {
                    unsignedTx.change(options.changeAddress)
                }

                if (options.sequence !== undefined) {
                    unsignedTx.inputs[1].sequenceNumber = options.sequence
                }

                if (options.lockTime !== undefined) {
                    unsignedTx.nLockTime = options.lockTime
                }

                return Promise.resolve({
                    tx: unsignedTx,
                    atInputIndex: 1,
                    nexts: [],
                })
            }
        )

        let contractTx = await currentInstance.methods.close(
            (sigResps) => findSig(sigResps, publicKeyAuctioneer),
            toByteString('00'.repeat(128)), // Fill with some dummy data to compensate for the fee after we pass the real data.
            {
                fromUTXO,
                pubKeyOrAddrToSign: publicKeyAuctioneer,
                changeAddress: addressAuctioneer,
                lockTime: auctionDeadline + 1,
                sequence: 0,
                exec: false,
            } as MethodCallOptions<OrdinalAuction>
        )

        currentInstance.bindTxBuilder(
            'close',
            async (
                current: OrdinalAuction,
                options: MethodCallOptions<OrdinalAuction>,
                sigAuctioneer: Sig,
                prevouts: ByteString
            ) => {
                return Promise.resolve({
                    tx: contractTx.tx,
                    atInputIndex: 1,
                    nexts: [],
                })
            }
        )

        // Assemble prevouts byte string.
        let prevouts = toByteString('')
        contractTx.tx.inputs.forEach((input) => {
            prevouts += reverseByteString(
                toByteString(input.prevTxId.toString('hex')),
                32n
            )
            prevouts += int2ByteString(BigInt(input.outputIndex), 4n)
        })

        contractTx = await currentInstance.methods.close(
            (sigResps) => findSig(sigResps, publicKeyAuctioneer),
            prevouts,
            {
                fromUTXO,
                pubKeyOrAddrToSign: publicKeyAuctioneer,
                changeAddress: addressAuctioneer,
                lockTime: auctionDeadline + 1,
                sequence: 0,
                autoPayFee: false,
            } as MethodCallOptions<OrdinalAuction>
        )

        const result = contractTx.tx.verifyScript(contractTx.atInputIndex)
        expect(result.success, result.error).to.eq(true)

        // If we would like to broadcast, here we need to sign ordinal UTXO input.
    })
})
