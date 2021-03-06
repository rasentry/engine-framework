var FObject = require('./fobject');

/**
 * The base class for registering asset types. This is a static class.
 *
 * You may want to override:
 * - createNode (static)
 *
 * @class RawAsset
 * @extends FObject
 * @static
 */
Fire.RawAsset = Fire.Class({
    name: 'Fire.RawAsset', extends: FObject,

    statics: {
        /**
         * Create a new node in the scene.
         * If this type of asset dont have its corresponding node type, this method should be null.
         * @method createNodeByUrl
         * @param {string} url
         * @param {function} callback
         * @param {string} callback.error - null or the error info
         * @param {object} callback.node - the created node or null
         */
        createNodeByUrl: null,
    }
});

module.exports = Fire.RawAsset;
