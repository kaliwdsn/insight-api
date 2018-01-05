'use strict';

var bitcore = require('bitcore-lib');
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var Common = require('./common');
var async = require('async');
var Request = require('request');

var MAXINT = 0xffffffff; // Math.pow(2, 32) - 1;

function TxController(node) {
  this.node = node;
  this.common = new Common({log: this.node.log});
}

TxController.prototype.show = function(req, res) {
  if (req.transaction) {
    res.jsonp(req.transaction);
  }
};

/**
 * Find transaction by hash ...
 */
TxController.prototype.transaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getDetailedTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    self.transformTransaction(transaction, function(err, transformedTransaction) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      req.transaction = transformedTransaction;
      next();
    });

  });
};

TxController.prototype.transformTransaction = function(transaction, options, callback) {
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }
  $.checkArgument(_.isFunction(callback));

  var confirmations = 0;
  if(transaction.height >= 0) {
    confirmations = this.node.services.bitcoind.height - transaction.height + 1;
  }

  var transformed = {
    txid: transaction.hash,
    version: transaction.version,
    locktime: transaction.locktime
  };

  if(transaction.coinbase) {
    transformed.vin = [
      {
        coinbase: transaction.inputs[0].script,
        sequence: transaction.inputs[0].sequence,
        n: 0
      }
    ];
  } else {
    transformed.vin = transaction.inputs.map(this.transformInput.bind(this, options));
  }


  var self = this;

  var wrappedOutputs = transaction.outputs.map(function(output, index) {
    return {index: index, output: output};
  });

  async.map(wrappedOutputs, function(item, cb) {
      var output = self.transformOutput(options, item.output, item.index);
      if (!item.output.address && item.index > 0) {
        var address = transaction.outputs[item.index - 1].address;
        if (address) {
          return getAssetByAddress(address, function(err, metadata) {
            output.metadata = metadata || null;
            cb(err, output);
          });
        } 
      }

      cb(null, output);

  }, function(err, vout) {
    transformed.vout = vout;
    transformed.blockhash = transaction.blockHash;
    transformed.blockheight = transaction.height;
    transformed.confirmations = confirmations;
    // TODO consider mempool txs with receivedTime?
    var time = transaction.blockTimestamp ? transaction.blockTimestamp : Math.round(Date.now() / 1000);
    transformed.time = time;
    if (transformed.confirmations) {
        transformed.blocktime = transformed.time;
    }
  
    if(transaction.coinbase) {
        transformed.isCoinBase = true;
    }
  
    transformed.valueOut = transaction.outputSatoshis / 1e8;
    transformed.size = transaction.hex.length / 2; // in bytes
    if (!transaction.coinbase) {
        transformed.valueIn = transaction.inputSatoshis / 1e8;
        transformed.fees = transaction.feeSatoshis / 1e8;
    }
  
    callback(null, transformed);
  });
};

TxController.prototype.transformInput = function(options, input, index) {
  // Input scripts are validated and can be assumed to be valid
  var transformed = {
    txid: input.prevTxId,
    vout: input.outputIndex,
    sequence: input.sequence,
    n: index
  };

  if (!options.noScriptSig) {
    transformed.scriptSig = {
      hex: input.script
    };
    if (!options.noAsm) {
      transformed.scriptSig.asm = input.scriptAsm;
    }
  }

  transformed.addr = input.address;
  transformed.valueSat = input.satoshis;
  transformed.value = input.satoshis / 1e8;
  transformed.doubleSpentTxID = null; // TODO
  //transformed.isConfirmed = null; // TODO
  //transformed.confirmations = null; // TODO
  //transformed.unconfirmedInput = null; // TODO

  return transformed;
};

TxController.prototype.transformOutput = function(options, output, index) {
  var transformed = {
    value: (output.satoshis / 1e8).toFixed(8),
    n: index,
    scriptPubKey: {
      hex: output.script
    }
  };

  if (!options.noAsm) {
    transformed.scriptPubKey.asm = output.scriptAsm;
  }

  if (!options.noSpent) {
    transformed.spentTxId = output.spentTxId || null;
    transformed.spentIndex = _.isUndefined(output.spentIndex) ? null : output.spentIndex;
    transformed.spentHeight = output.spentHeight || null;
  }

  if (output.address) {
    transformed.scriptPubKey.addresses = [output.address];
    var address = bitcore.Address(output.address); //TODO return type from bitcore-node
    transformed.scriptPubKey.type = address.type;
  }

  return transformed;
};

TxController.prototype.transformInvTransaction = function(transaction) {
  var self = this;

  var valueOut = 0;
  var vout = [];
  for (var i = 0; i < transaction.outputs.length; i++) {
    var output = transaction.outputs[i];
    valueOut += output.satoshis;
    if (output.script) {
      var address = output.script.toAddress(self.node.network);
      if (address) {
        var obj = {};
        obj[address.toString()] = output.satoshis;
        vout.push(obj);
      }
    }
  }

  var isRBF = _.any(_.pluck(transaction.inputs, 'sequenceNumber'), function(seq) {
    return seq < MAXINT - 1;
  });

  var transformed = {
    txid: transaction.hash,
    valueOut: valueOut / 1e8,
    vout: vout,
    isRBF: isRBF,
  };

  return transformed;
};

TxController.prototype.rawTransaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    req.rawTransaction = {
      'rawtx': transaction.toBuffer().toString('hex')
    };

    next();
  });
};

TxController.prototype.showRaw = function(req, res) {
  if (req.rawTransaction) {
    res.jsonp(req.rawTransaction);
  }
};

TxController.prototype.list = function(req, res) {
  var self = this;

  var blockHash = req.query.block;
  var address = req.query.address;
  var page = parseInt(req.query.pageNum) || 0;
  var pageLength = 10;
  var pagesTotal = 1;

  if(blockHash) {
    self.node.getBlockOverview(blockHash, function(err, block) {
      if(err && err.code === -5) {
        return self.common.handleErrors(null, res);
      } else if(err) {
        return self.common.handleErrors(err, res);
      }

      var totalTxs = block.txids.length;
      var txids;

      if(!_.isUndefined(page)) {
        var start = page * pageLength;
        txids = block.txids.slice(start, start + pageLength);
        pagesTotal = Math.ceil(totalTxs / pageLength);
      } else {
        txids = block.txids;
      }

      async.mapSeries(txids, function(txid, next) {
        self.node.getDetailedTransaction(txid, function(err, transaction) {
          if (err) {
            return next(err);
          }
          self.transformTransaction(transaction, next);
        });
      }, function(err, transformed) {
        if(err) {
          return self.common.handleErrors(err, res);
        }

        res.jsonp({
          pagesTotal: pagesTotal,
          txs: transformed
        });
      });

    });
  } else if(address) {
    var options = {
      from: page * pageLength,
      to: (page + 1) * pageLength
    };

    self.node.getAddressHistory(address, options, function(err, result) {
      if(err) {
        return self.common.handleErrors(err, res);
      }

      var txs = result.items.map(function(info) {
        return info.tx;
      }).filter(function(value, index, self) {
        return self.indexOf(value) === index;
      });

      async.map(
        txs,
        function(tx, next) {
          self.transformTransaction(tx, next);
        },
        function(err, transformed) {
          if (err) {
            return self.common.handleErrors(err, res);
          }
          res.jsonp({
            pagesTotal: Math.ceil(result.totalCount / pageLength),
            txs: transformed
          });
        }
      );
    });
  } else {
    return self.common.handleErrors(new Error('Block hash or address expected'), res);
  }
};

TxController.prototype.send = function(req, res) {
  var self = this;
  this.node.sendTransaction(req.body.rawtx, function(err, txid) {
    if(err) {
      // TODO handle specific errors
      return self.common.handleErrors(err, res);
    }

    res.json({'txid': txid});
  });
};

function getAssetByAddress(address, callback) {
    Request('http://127.0.0.1:8080/v3/addressinfo/' + address, function(err, response, body) {
      if (err) {
        return callback(err);
      }

      try {
        body = JSON.parse(body);
        var assetsInfo = extractAssets(body);
        async.map(assetsInfo, function(item, cb) {
            getMeta(item, function(err, metadata) {
              cb(err, metadata);
            });
        }, function(err, results) {
            if (err) {
              return callback(err);
            }

            callback(null, results);
        });     
      } catch (e) {
        console.error(e);
        callback(e);
      }
    });
}

function getMeta(asset, callback) {
  Request('http://127.0.0.1:8080/v3/assetmetadata/' + assetUtxoId(asset), function(err, response, body) {
      if (err) {
        return callback(err);
      }

      try {
        var metadata = JSON.parse(body);
        callback(null, {
          assetId: asset.assetId,
          utxo: asset.utxo,
          asset: asset,
          divisible: metadata.divisibility,
          reissuable: metadata.lockStatus == false,
          issuanceTxid: metadata.issuanceTxid,
          issueAddress: metadata.issueAddress,
          metadata: metadata.metadataOfIssuence.data,
        });
      } catch (e) {
        return callback(e);
      }
    });
}

function assetUtxoId(asset) {
  return asset.assetId + "/" + asset.utxo.txid + ":" + asset.utxo.index;
};


function extractAssets(body) {
  var assets = [];
  if (!body.utxos || body.utxos.length == 0) return assets;

  body.utxos.forEach(function(utxo) {
    if (utxo.assets || utxo.assets.length > 0) {
      utxo.assets.forEach(function(asset) {
        assets.push({ assetId: asset.assetId, amount: asset.amount, utxo: _.pick(utxo, [ 'txid', 'index', 'value', 'scriptPubKey']) });
      });
    }
  });

  return assets;
};


module.exports = TxController;
