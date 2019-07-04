var Bitso = require('bitso-api')
  , moment = require('moment')
  , n = require('numbro')
  // eslint-disable-next-line no-unused-vars
  , colors = require('colors')
  , _ = require('underscore')

module.exports = function container(conf) {

  var public_client, authed_client

  function publicClient(/*product_id*/) {
    if (!public_client) public_client = new Bitso({ key: '', secret: '' })
    return public_client
  }

  function authedClient() {
    if (!authed_client) {
      if (!conf.bitso || !conf.bitso.key || conf.bitso.key === 'YOUR-API-KEY') {
        throw new Error('please configure your Bitso credentials in conf.js')
      }
      authed_client = new Bitso({ key: conf.bitso.key, secret: conf.bitso.secret })
    }
    return authed_client
  }

  function joinProduct(product_id) {
    return product_id.split('-')[1] + '_' + product_id.split('-')[0]
  }

  function retry(method, args) {
    setTimeout(function () {
      exchange[method].apply(exchange, args)
    }, 1)
  }

  var orders = {}

  var exchange = {
    name: 'bitso',
    historyScan: 'backward',
    makerFee: 0.50,
    takerFee: 0.65,

    getProducts: function () {
      return require('./products.json')
    },

    getTrades: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = publicClient()
      var params = {book: 'btc_mxn', limit: 100}
      if (opts.trade_id) {
        // move cursor into the future
        params.marker = opts.trade_id
      }

      client.trades({
        params,
        success: data => success(data.payload),
        error: data => error(data)
      })

      function success(data) {
        var trades = data.map(trade => ({
          trade_id: trade.tid,
          time: moment.utc(trade.created_at).valueOf(),
          size: parseFloat(trade.amount),
          price: parseFloat(trade.price),
          side: trade.maker_side
        }))
        cb(null, trades)
      }

      function error(data) {
        console.error('\ngetQuote error:')
        console.error(data)
        return retry('getQuote', func_args)
      }

      /* client._public('returnTradeHistory', args, function (err, body) {
        if (err) return cb(err)
        if (typeof body === 'string') {
          return retry('getTrades', func_args)
        }
        if (!body.map) {
          console.error('\ngetTrades odd result:')
          console.error(body)
          return retry('getTrades', func_args)
        }

        if (body.length >= 50000) {
          func_args[0].offset = opts.offset / 2;
          return retry('getTrades', func_args)
        }

        var trades = body.map(function (trade) {
          return {
            trade_id: trade.tradeID,
            time: moment.utc(trade.date).valueOf(),
            size: Number(trade.amount),
            price: Number(trade.rate),
            side: trade.type
          }
        })
        cb(null, trades)
      }) */
    },

    getBalance: function (opts, cb) {
      var args = [].slice.call(arguments)
      var client = authedClient()

      client.balance({
        success: data => success(data.payload.balances),
        error: data => error(data),
      })

      function error(data) {
        console.error('\ngetBalance error:')
        console.error(data.error)
        return retry('getBalance', args)
      }

      function success(data) {
        var balance = { asset: 0, currency: 0 }

        const findAsset = item => item.currency === opts.asset.toLowerCase()
        balance.asset = parseFloat(_.find(data, findAsset).total)
        balance.asset_hold = parseFloat(_.find(data, findAsset).locked)

        const findCurrency = item => item.currency === opts.currency.toLowerCase()
        balance.currency = parseFloat(_.find(data, findCurrency).total)
        balance.currency_hold = parseFloat(_.find(data, findCurrency).locked)

        cb(null, balance)
      }
    },

    getOrderBook: function (opts, cb) {
      var client = publicClient()
      var params = {
        currencyPair: joinProduct(opts.product_id),
        depth: 10
      }
      client._public('returnOrderBook', params, function (err, data) {
        if (typeof data !== 'object') {
          return cb(null, [])
        }
        if (data.error) {
          console.error('getOrderBook error:')
          console.error(data)
          return retry('getOrderBook', params)
        }
        cb(null, {
          buyOrderRate: data.bids[0][0],
          buyOrderAmount: data.bids[0][1],
          sellOrderRate: data.asks[0][0],
          sellOrderAmount: data.asks[0][1]
        })
      })
    },

    getQuote: function (opts, cb) {
      var args = [].slice.call(arguments)
      var client = publicClient()

      client.ticker({
        params: {
          book: 'btc_mxn'
        },
        success: data => success(data.payload),
        error: data => error(data)
      })

      function success(data) {
        cb(null, { bid: data.bid, ask: data.ask })
      }

      function error(data) {
        console.error('\ngetQuote error:')
        console.error(data)
        return retry('getQuote', args)
      }
    },

    cancelOrder: function (opts, cb) {
      var args = [].slice.call(arguments)
      var client = authedClient()
      client._private('cancelOrder', { orderNumber: opts.order_id }, function (err, result) {
        if (typeof result === 'string') {
          return retry('cancelOrder', args)
        }
        if (!err && !result.success) {
          // sometimes the order gets cancelled on the server side for some reason and we get this. ignore that case...
          if (result.error !== 'Invalid order number, or you are not the person who placed the order.') {
            err = new Error('unable to cancel order')
            err.body = result
          }
        }
        cb(err)
      })
    },

    trade: function (type, opts, cb) {
      var args = [].slice.call(arguments)
      var client = authedClient()
      var params = {
        currencyPair: joinProduct(opts.product_id),
        rate: opts.price,
        amount: opts.size,
        postOnly: opts.post_only === false ? '0' : '1'
      }
      client._private(type, params, function (err, result) {
        if (typeof result === 'string') {
          return retry('trade', args)
        }
        var order = {
          id: result ? result.orderNumber : null,
          status: 'open',
          price: opts.price,
          size: opts.size,
          post_only: !!opts.post_only,
          created_at: new Date().getTime(),
          filled_size: '0'
        }
        if (result && result.error === 'Unable to place post-only order at this price.') {
          order.status = 'rejected'
          order.reject_reason = 'post only'
          return cb(null, order)
        }
        else if (result && result.error && result.error.match(/^Not enough/)) {
          order.status = 'rejected'
          order.reject_reason = 'balance'
          return cb(null, order)
        } else if (result && result.error && result.error.match(/^Nonce must be greater/)) {
          return retry('trade', args)
        }
        if (!err && result.error) {
          err = new Error('unable to ' + type)
          err.body = result
        }
        if (err) return cb(err)
        orders['~' + result.orderNumber] = order
        cb(null, order)
      })
    },

    buy: function (opts, cb) {
      exchange.trade('buy', opts, cb)
    },

    sell: function (opts, cb) {
      exchange.trade('sell', opts, cb)
    },

    getOrder: function (opts, cb) {
      var args = [].slice.call(arguments)
      var order = orders['~' + opts.order_id]
      if (!order) return cb(new Error('order not found in cache'))
      var client = authedClient()
      var params = {
        currencyPair: joinProduct(opts.product_id)
      }
      client._private('returnOpenOrders', params, function (err, body) {
        if (err) return cb(err)
        if (typeof body === 'string' || !body) {
          return retry('getOrder', args)
        }
        var active = false
        if (!body.forEach) {
          console.error('\nreturnOpenOrders odd result in checking state of order, trying again')
          //console.error(body)
          return retry('getOrder', args)
        }
        else {
          body.forEach(function (api_order) {
            if (api_order.orderNumber == opts.order_id) active = true
          })
        }
        client.returnOrderTrades(opts.order_id, function (err, body) {
          if (typeof body === 'string' || !body) {
            return retry('getOrder', args)
          }
          if (err || body.error || !body.forEach) return cb(null, order)
          if (body.length === 0 && !active) {
            order.status = 'cancelled'
            return cb(null, order)
          }
          order.filled_size = '0'
          body.forEach(function (trade) {
            order.filled_size = n(order.filled_size).add(trade.amount).format('0.00000000')
          })
          if (n(order.filled_size).value() == n(order.size).value()) {
            order.status = 'done'
            order.done_at = new Date().getTime()
          }
          cb(null, order)
        })
      })
    },

    // return the property used for range querying.
    getCursor: function (trade) {
      return Math.floor((trade.time || trade) / 1000)
    }
  }
  return exchange
}
