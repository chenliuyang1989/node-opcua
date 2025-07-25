/**
 * @module node-opcua-client-private
 */
import { EventEmitter } from "events";
import { callbackify } from "util";
import chalk from "chalk";
import { assert } from "node-opcua-assert";
import { AggregateFunction } from "node-opcua-constants";
import { DateTime } from "node-opcua-basic-types";
import {
    extractDataValueToPromote,
    ExtraDataTypeManager,
    getExtensionObjectConstructor,
    getExtraDataTypeManager,
    promoteOpaqueStructure,
    PseudoDataValue
} from "node-opcua-client-dynamic-extension-object";
import { Certificate, Nonce } from "node-opcua-crypto/web";
import { BrowseDirection, LocalizedTextLike } from "node-opcua-data-model";
import { DataValue } from "node-opcua-data-value";
import { checkDebugFlag, make_debugLog, make_errorLog, make_warningLog } from "node-opcua-debug";
import { ExtensionObject } from "node-opcua-extension-object";
import { coerceNodeId, NodeId, NodeIdLike, resolveNodeId } from "node-opcua-nodeid";
import {
    getBuiltInDataType,
    getArgumentDefinitionHelper,
    IBasicTransportSettings,
    readAllAttributes,
    NodeAttributes,
    ResponseCallback,
    BrowseDescriptionLike,
    IBasicSessionAsync2,
    readNamespaceArray
} from "node-opcua-pseudo-session";
import { AnyConstructorFunc } from "node-opcua-schemas";
import { ClientSecureChannelLayer, requestHandleNotSetValue, SignatureData } from "node-opcua-secure-channel";
import { BrowseDescription, BrowseRequest, BrowseResponse, BrowseResult } from "node-opcua-service-browse";
import { CallMethodRequest, CallMethodResult, CallRequest, CallResponse } from "node-opcua-service-call";
import { EndpointDescription } from "node-opcua-service-endpoints";
import {
    HistoryReadRequest,
    HistoryReadResponse,
    HistoryReadResult,
    ReadRawModifiedDetails,
    ReadProcessedDetails
} from "node-opcua-service-history";
import { QueryFirstRequest, QueryFirstResponse } from "node-opcua-service-query";
import {
    AttributeIds,
    ReadRequest,
    ReadResponse,
    ReadValueId,
    ReadValueIdOptions,
    TimestampsToReturn
} from "node-opcua-service-read";
import {
    RegisterNodesRequest,
    RegisterNodesResponse,
    UnregisterNodesRequest,
    UnregisterNodesResponse
} from "node-opcua-service-register-node";
import {
    CreateMonitoredItemsRequest,
    CreateMonitoredItemsResponse,
    CreateSubscriptionRequest,
    CreateSubscriptionResponse,
    DeleteMonitoredItemsRequest,
    DeleteMonitoredItemsResponse,
    DeleteSubscriptionsRequest,
    DeleteSubscriptionsResponse,
    ModifyMonitoredItemsRequest,
    ModifyMonitoredItemsResponse,
    ModifySubscriptionRequest,
    ModifySubscriptionResponse,
    PublishRequest,
    PublishResponse,
    RepublishRequest,
    RepublishResponse,
    SetMonitoringModeRequest,
    SetMonitoringModeResponse,
    SetPublishingModeRequest,
    SetPublishingModeResponse,
    SetTriggeringRequestOptions,
    SetTriggeringResponse,
    SetTriggeringRequest,
    TransferSubscriptionsRequest,
    TransferSubscriptionsResponse
} from "node-opcua-service-subscription";
import {
    BrowsePath,
    BrowsePathResult,
    TranslateBrowsePathsToNodeIdsRequest,
    TranslateBrowsePathsToNodeIdsResponse
} from "node-opcua-service-translate-browse-path";
import { WriteRequest, WriteResponse, WriteValue } from "node-opcua-service-write";
import { StatusCode, StatusCodes, Callback, CallbackT } from "node-opcua-status-code";
import { ErrorCallback } from "node-opcua-status-code";
import {
    ActivateSessionRequest,
    AggregateConfigurationOptions,
    BrowseNextRequest,
    BrowseNextResponse,
    CloseSessionRequest,
    HistoryReadValueIdOptions,
    UserTokenType,
    WriteValueOptions
} from "node-opcua-types";
import { buffer_ellipsis, getFunctionParameterNames, isNullOrUndefined } from "node-opcua-utils";
import { DataType, Variant, VariantLike } from "node-opcua-variant";

import {
    ArgumentDefinition,
    CallMethodRequestLike,
    ClientSession,
    CreateMonitoredItemsRequestLike,
    CreateSubscriptionRequestLike,
    DeleteMonitoredItemsRequestLike,
    DeleteSubscriptionsRequestLike,
    MethodId,
    ModifyMonitoredItemsRequestLike,
    ModifySubscriptionRequestLike,
    MonitoredItemData,
    QueryFirstRequestLike,
    SetMonitoringModeRequestLike,
    SubscriptionId,
    TransferSubscriptionsRequestLike,
    HistoryReadValueIdOptions2,
    ExtraReadHistoryValueParameters
} from "../client_session";
import { UserIdentityInfo } from "../user_identity_info";
import { ClientSessionKeepAliveManager } from "../client_session_keepalive_manager";
import { ClientSubscription } from "../client_subscription";
import { Request, Response } from "../common";

import { ClientSidePublishEngine } from "./client_publish_engine";
import { ClientSubscriptionImpl } from "./client_subscription_impl";
import { IClientBase } from "./i_private_client";
import { repair_client_session } from "./reconnection/reconnection";

const helpAPIChange = process.env.DEBUG && process.env.DEBUG.match(/API/);
const debugLog = make_debugLog(__filename);
const doDebug = checkDebugFlag(__filename);
const warningLog = make_warningLog(__filename);
const errorLog = make_errorLog(__filename);

let pendingTransactionMessageDisplayed = false;

function coerceBrowseDescription(data: any): BrowseDescription {
    if (typeof data === "string" || data instanceof NodeId) {
        return coerceBrowseDescription({
            browseDirection: BrowseDirection.Forward,
            includeSubtypes: true,
            nodeClassMask: 0,
            nodeId: data,
            referenceTypeId: "HierarchicalReferences",
            resultMask: 63
        });
    } else {
        data.nodeId = resolveNodeId(data.nodeId);
        data.referenceTypeId = data.referenceTypeId ? resolveNodeId(data.referenceTypeId) : null;
        return new BrowseDescription(data);
    }
}

function coerceReadValueId(node: any): ReadValueId {
    if (typeof node === "string" || node instanceof NodeId) {
        return new ReadValueId({
            attributeId: AttributeIds.Value,
            dataEncoding: undefined, // {namespaceIndex: 0, name: undefined}
            indexRange: undefined,
            nodeId: resolveNodeId(node)
        });
    } else {
        assert(node instanceof Object);
        return new ReadValueId(node);
    }
}

const emptyUint32Array = new Uint32Array(0);

type EmptyCallback = (err?: Error) => void;

export interface Reconnectable {
    _reconnecting: {
        reconnecting: boolean;
        pendingCallbacks: EmptyCallback[];
        pendingTransactions: { request: Request, callback: (err: Error | null, response?: Response) => void }[];
    };
}

/**
 * @class ClientSession
 */
export class ClientSessionImpl extends EventEmitter implements ClientSession, Reconnectable {
    static reconnectingElement: WeakMap<ClientSessionImpl, Reconnectable> = new WeakMap();
    public timeout: number;
    public authenticationToken?: NodeId;
    public requestedMaxReferencesPerNode: number;
    public sessionId: NodeId;
    public lastRequestSentTime: Date;
    public lastResponseReceivedTime: Date;
    public serverCertificate: Certificate;
    public userIdentityInfo?: UserIdentityInfo;
    public name = "";
    public serverNonce?: Nonce;
    public serverSignature?: SignatureData; // todo : remove ?
    public serverEndpoints: EndpointDescription[] = [];
    public _client: IClientBase | null;
    public _closed: boolean;

    public _reconnecting: {
        reconnecting: boolean;
        pendingCallbacks: EmptyCallback[];
        pendingTransactions: any[];
    };

    /**
     * @internal
     */
    public _closeEventHasBeenEmitted: boolean;
    private _publishEngine: ClientSidePublishEngine | null;
    private _keepAliveManager?: ClientSessionKeepAliveManager;
    private $$namespaceArray?: string[];
    private recursive_repair_detector = 0;

    constructor(client: IClientBase) {
        super();

        this.serverCertificate = Buffer.alloc(0);

        this.sessionId = new NodeId();

        this._closeEventHasBeenEmitted = false;
        this._client = client;
        this._publishEngine = null;

        this._closed = false;

        this._reconnecting = {
            reconnecting: false,
            pendingCallbacks: [],
            pendingTransactions: []
        };

        this.requestedMaxReferencesPerNode = 10000;
        this.lastRequestSentTime = new Date(1, 1, 1970);
        this.lastResponseReceivedTime = new Date(1, 1, 1970);
        this.timeout = 0;
    }

    getTransportSettings(): IBasicTransportSettings {
        return this._client!.getTransportSettings();
    }
    /**
     * the endpoint on which this session is operating
     * @property endpoint
     * @type {EndpointDescription}
     */
    get endpoint(): EndpointDescription {
        return this._client!.endpoint!;
    }

    get subscriptionCount(): number {
        return this._publishEngine ? this._publishEngine.subscriptionCount : 0;
    }

    get isReconnecting(): boolean {
        return this._client ? this._client.isReconnecting || this._reconnecting?.reconnecting : false;
    }

    protected resolveNodeId(nodeId: NodeIdLike): NodeIdLike {
        return resolveNodeId(nodeId);
    }
    public getPublishEngine(): ClientSidePublishEngine {
        if (!this._publishEngine) {
            this._publishEngine = new ClientSidePublishEngine(this);
        }
        return this._publishEngine!;
    }

    public changeUser(userIdentityInfo: UserIdentityInfo): Promise<StatusCode>;
    public changeUser(userIdentityInfo: UserIdentityInfo, callback: CallbackT<StatusCode>): void;
    public changeUser(userIdentityInfo: UserIdentityInfo, callback?: CallbackT<StatusCode>): any {
        userIdentityInfo = userIdentityInfo || {
            type: UserTokenType.Anonymous
        };
        if (!this._client || !this.userIdentityInfo) {
            warningLog("changeUser: invalid session");
            return callback!(null, StatusCodes.BadInternalError);
        }

        const old_userIdentity: UserIdentityInfo = this.userIdentityInfo;

        this._client._activateSession(this, userIdentityInfo, (err1: Error | null, session2?: ClientSessionImpl) => {
            if (err1) {
                this.userIdentityInfo = old_userIdentity;
                warningLog("activate session error = ", err1.message);
                return callback!(null, StatusCodes.BadUserAccessDenied);
            }
            this.userIdentityInfo = userIdentityInfo;
            callback!(null, StatusCodes.Good);
        });
    }
    /**
     *
     * @example
     *
     *    ```javascript
     *    session.browse("RootFolder",function(err,browseResult) {
     *      if(err) return callback(err);
     *      console.log(browseResult.toString());
     *      callback();
     *    } );
     *    ```
     *
     *
     * @example
     *
     *    ``` javascript
     *    const browseDescription = {
     *       nodeId: "ObjectsFolder",
     *       referenceTypeId: "Organizes",
     *       browseDirection: BrowseDirection.Inverse,
     *       includeSubtypes: true,
     *       nodeClassMask: 0,
     *       resultMask: 63
     *    }
     *    session.browse(browseDescription,function(err, browseResult) {
     *       if(err) return callback(err);
     *       console.log(browseResult.toString());
     *       callback();
     *    });
     *    ```
     * @example
     *
     * ``` javascript
     * session.browse([ "RootFolder", "ObjectsFolder"],function(err, browseResults) {
     *       assert(browseResults.length === 2);
     * });
     * ```
     *
     * @example
     * ``` javascript
     * const browseDescriptions = [
     * {
     *   nodeId: "ObjectsFolder",
     *   referenceTypeId: "Organizes",
     *   browseDirection: BrowseDirection.Inverse,
     *   includeSubtypes: true,
     *   nodeClassMask: 0,
     *   resultMask: 63
     * },
     * // {...}
     * ]
     *  session.browse(browseDescriptions,function(err, browseResults) {
     *
     *   });
     * ```
     *
     *
     */
    public browse(nodeToBrowse: BrowseDescriptionLike, callback: ResponseCallback<BrowseResult>): void;

    public browse(nodesToBrowse: BrowseDescriptionLike[], callback: ResponseCallback<BrowseResult[]>): void;

    public async browse(nodeToBrowse: BrowseDescriptionLike): Promise<BrowseResult>;

    public async browse(nodesToBrowse: BrowseDescriptionLike[]): Promise<BrowseResult[]>;
    /**
     * @internal
     * @param args
     */
    public browse(...args: any[]): any {
        const arg0 = args[0];
        const isArray = Array.isArray(arg0);
        const callback: ResponseCallback<BrowseResult[] | BrowseResult> = args[1];
        assert(typeof callback === "function");

        assert(isFinite(this.requestedMaxReferencesPerNode));

        const nodesToBrowse: BrowseDescription[] = (isArray ? arg0 : [arg0 as BrowseDescription]).map(coerceBrowseDescription);

        const request = new BrowseRequest({
            nodesToBrowse,
            requestedMaxReferencesPerNode: this.requestedMaxReferencesPerNode
        });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            if (err) {
                return callback(err);
            }

            /* istanbul ignore next */
            if (!response || !(response instanceof BrowseResponse)) {
                return callback(new Error("Internal Error"));
            }

            const results: BrowseResult[] = response.results ? response.results : [];

            if (this.requestedMaxReferencesPerNode > 0) {
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];

                    /* istanbul ignore next */
                    if (r.references && r.references.length > this.requestedMaxReferencesPerNode) {
                        warningLog(
                            chalk.yellow("warning") +
                                " BrowseResponse : the server didn't take into" +
                                " account our requestedMaxReferencesPerNode "
                        );
                        warningLog("        this.requestedMaxReferencesPerNode= " + this.requestedMaxReferencesPerNode);
                        warningLog("        got " + r.references.length + "for " + nodesToBrowse[i].nodeId.toString());
                        warningLog("        continuationPoint ", r.continuationPoint);
                    }
                }
            }
            for (const r of results) {
                r.references = r.references || /* istanbul ignore next */ [];
            }
            assert(results[0] instanceof BrowseResult);
            return callback(null, isArray ? results : results[0]);
        });
    }

    public browseNext(
        continuationPoint: Buffer,
        releaseContinuationPoints: boolean,
        callback: ResponseCallback<BrowseResult>
    ): void;

    public browseNext(
        continuationPoints: Buffer[],
        releaseContinuationPoints: boolean,
        callback: ResponseCallback<BrowseResult[]>
    ): void;

    public async browseNext(continuationPoint: Buffer, releaseContinuationPoints: boolean): Promise<BrowseResult>;
    public async browseNext(continuationPoints: Buffer[], releaseContinuationPoints: boolean): Promise<BrowseResult[]>;
    public browseNext(...args: any[]): any {
        const arg0 = args[0];
        const isArray = Array.isArray(arg0);
        const releaseContinuationPoints = args[1] as boolean;
        const callback: any = args[2];
        assert(typeof callback === "function", "expecting a callback function here");

        const continuationPoints: Buffer[] = isArray ? arg0 : [arg0 as Buffer];

        const request = new BrowseNextRequest({
            continuationPoints,
            releaseContinuationPoints
        });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }

            /* istanbul ignore next */
            if (!response || !(response instanceof BrowseNextResponse)) {
                return callback(new Error("Internal Error"));
            }
            const results: BrowseResult[] = response.results ? response.results : [];

            for (const r of results) {
                r.references = r.references || [];
            }
            assert(results[0] instanceof BrowseResult);
            return callback(null, isArray ? results : results[0]);
        });
    }

    /**
     *
     * @example
     *
     * ```javascript
     *     session.readVariableValue("ns=2;s=Furnace_1.Temperature",function(err,dataValue) {
     *        if(err) { return callback(err); }
     *        if (dataValue.isGood()) {
     *        }
     *        console.log(dataValue.toString());
     *        callback();
     *     });
     * ```
     *
     * @example
     *
     * ```javascript
     *   session.readVariableValue(["ns=0;i=2257","ns=0;i=2258"],function(err,dataValues) {
     *      if (!err) {
     *         console.log(dataValues[0].toString());
     *         console.log(dataValues[1].toString());
     *      }
     *   });
     * ```
     *
     * @example
     * ```javascript
     *     const dataValues = await session.readVariableValue(["ns=1;s=Temperature","ns=1;s=Pressure"]);
     * ```
     *
     * @deprecated
     */
    public readVariableValue(nodeId: NodeIdLike, callback: ResponseCallback<DataValue>): void;
    public readVariableValue(nodeIds: NodeIdLike[], callback: ResponseCallback<DataValue[]>): void;
    public async readVariableValue(nodeId: NodeIdLike): Promise<DataValue>;
    public async readVariableValue(nodeIds: NodeIdLike[]): Promise<DataValue[]>;
    /**
     * @internal
     * @param args
     */
    public readVariableValue(...args: any[]): any {
        const callback = args[1];
        assert(typeof callback === "function");

        const isArray = Array.isArray(args[0]);

        const nodes = isArray ? args[0] : [args[0]];

        const nodesToRead = nodes.map(coerceReadValueId);

        const request = new ReadRequest({
            nodesToRead,
            timestampsToReturn: TimestampsToReturn.Neither
        });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }

            /* istanbul ignore next */
            if (!(response instanceof ReadResponse)) {
                return callback(new Error("Internal Error"));
            }

            /* istanbul ignore next */
            if (response.responseHeader.serviceResult.isNot(StatusCodes.Good)) {
                return callback(new Error(response.responseHeader.serviceResult.toString()));
            }

            /* istanbul ignore next */
            if (!response.results) {
                response.results = [];
            }

            assert(nodes.length === response.results.length);

            callback(null, isArray ? response.results : response.results[0]);
        });
    }

    /**
     *
     * @example
     *
     * ```javascript
     * //  es5
     * session.readHistoryValue(
     *   "ns=5;s=Simulation Examples.Functions.Sine1",
     *   "2015-06-10T09:00:00.000Z",
     *   "2015-06-10T09:01:00.000Z", function(err,dataValues) {
     *
     * });
     * ```
     *
     * ```javascript
     * //  es6
     * const dataValues = await session.readHistoryValue(
     *   "ns=5;s=Simulation Examples.Functions.Sine1",
     *   "2015-06-10T09:00:00.000Z",
     *   "2015-06-10T09:01:00.000Z");
     * ```
     * @param nodeToRead   the read value id
     * @param start   the start time in UTC format
     * @param end     the end time in UTC format
     * @param callback
     */
    public readHistoryValue(
        nodesToRead: NodeIdLike[] | HistoryReadValueIdOptions2[],
        start: DateTime,
        end: DateTime,
        callback: (err: Error | null, results?: HistoryReadResult[]) => void
    ): void;
    public readHistoryValue(
        nodesToRead: NodeIdLike[] | HistoryReadValueIdOptions2[],
        start: DateTime,
        end: DateTime,
        options: ExtraReadHistoryValueParameters | undefined,
        callback: (err: Error | null, results?: HistoryReadResult[]) => void
    ): void;
    public async readHistoryValue(
        nodesToRead: NodeIdLike[] | HistoryReadValueIdOptions2[],
        start: DateTime,
        end: DateTime,
        options?: ExtraReadHistoryValueParameters
    ): Promise<HistoryReadResult[]>;
    public readHistoryValue(
        nodeToRead: NodeIdLike | HistoryReadValueIdOptions2,
        start: DateTime,
        end: DateTime,
        callback: (err: Error | null, results?: HistoryReadResult) => void
    ): void;
    public readHistoryValue(
        nodeToRead: NodeIdLike | HistoryReadValueIdOptions2,
        start: DateTime,
        end: DateTime,
        options: ExtraReadHistoryValueParameters | undefined,
        callback: (err: Error | null, results?: HistoryReadResult) => void
    ): void;
    public async readHistoryValue(
        nodeToRead: NodeIdLike | HistoryReadValueIdOptions2,
        start: DateTime,
        end: DateTime,
        parameters: ExtraReadHistoryValueParameters
    ): Promise<HistoryReadResult>;
    public readHistoryValue(...args: any[]): any {
        const startTime = args[1];
        const endTime = args[2];

        let options: ExtraReadHistoryValueParameters = {};
        let callback = args[3];
        if (typeof callback !== "function") {
            options = args[3];
            callback = args[4];
        }
        assert(typeof callback === "function");

        // adjust parameters
        options.numValuesPerNode = options.numValuesPerNode || 0;
        options.returnBounds = options.returnBounds || options.returnBounds === undefined ? true : false;
        options.isReadModified = options.isReadModified || false;
        options.timestampsToReturn = options.timestampsToReturn ?? TimestampsToReturn.Both;

        const arg0 = args[0];
        const isArray = Array.isArray(arg0);

        const nodes = isArray ? arg0 : [arg0];

        const nodesToRead: HistoryReadValueIdOptions[] = [];

        for (const node of nodes) {
            if (!node.nodeId) {
                nodesToRead.push({
                    continuationPoint: undefined,
                    dataEncoding: undefined, // {namespaceIndex: 0, name: undefined},
                    indexRange: undefined,
                    nodeId: this.resolveNodeId(node as NodeIdLike)
                });
            } else {
                nodesToRead.push(node as HistoryReadValueIdOptions);
            }
        }

        const readRawModifiedDetails = new ReadRawModifiedDetails({
            endTime,
            isReadModified: false,
            numValuesPerNode: options.numValuesPerNode,
            returnBounds: options.returnBounds,
            startTime
        });

        const request = new HistoryReadRequest({
            historyReadDetails: readRawModifiedDetails,
            nodesToRead,
            releaseContinuationPoints: false,
            timestampsToReturn: options.timestampsToReturn
        });

        request.nodesToRead = request.nodesToRead || [];

        assert(nodes.length === request.nodesToRead.length);
        this.historyRead(request, (err: Error | null, response?: HistoryReadResponse) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }
            /* istanbul ignore next */
            if (!response || !(response instanceof HistoryReadResponse)) {
                return callback(new Error("Internal Error"));
            }
            response.results = response.results || [];
            assert(nodes.length === response.results.length);
            callback(null, isArray ? response.results : response.results[0]);
        });
    }

    public historyRead(request: HistoryReadRequest, callback: Callback<HistoryReadResponse>): void;
    public historyRead(request: HistoryReadRequest): Promise<HistoryReadResponse>;
    public historyRead(request: HistoryReadRequest, callback?: CallbackT<HistoryReadResponse>): any {
        /* istanbul ignore next */
        if (!callback) {
            throw new Error("expecting a callback");
        }

        this.performMessageTransaction(request, (err: Error | null, response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }

            /* istanbul ignore next */
            if (!response || !(response instanceof HistoryReadResponse)) {
                return callback(new Error("Internal Error"));
            }

            if (response.responseHeader.serviceResult.isNot(StatusCodes.Good)) {
                return callback(new Error(response.responseHeader.serviceResult.toString()));
            }

            response.results = response.results || /* istanbul ignore next */ [];
            callback(null, response);
        });
    }

    public readAggregateValue(
        nodesToRead: HistoryReadValueIdOptions[],
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction[],
        processingInterval: number,
        callback: Callback<HistoryReadResult[]>
    ): void;
    public async readAggregateValue(
        nodesToRead: HistoryReadValueIdOptions[],
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction[],
        processingInterval: number
    ): Promise<HistoryReadResult[]>;
    public readAggregateValue(
        nodeToRead: HistoryReadValueIdOptions,
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction,
        processingInterval: number,
        callback: Callback<HistoryReadResult>
    ): void;
    public async readAggregateValue(
        nodeToRead: HistoryReadValueIdOptions,
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction,
        processingInterval: number
    ): Promise<HistoryReadResult>;
    public readAggregateValue(
        nodesToRead: HistoryReadValueIdOptions[],
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction[],
        processingInterval: number,
        aggregateConfiguration: AggregateConfigurationOptions,
        callback: Callback<HistoryReadResult[]>
    ): void;
    public async readAggregateValue(
        nodesToRead: HistoryReadValueIdOptions[],
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction[],
        processingInterval: number,
        aggregateConfiguration: AggregateConfigurationOptions
    ): Promise<HistoryReadResult[]>;
    public readAggregateValue(
        nodeToRead: HistoryReadValueIdOptions,
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction,
        processingInterval: number,
        aggregateConfiguration: AggregateConfigurationOptions,
        callback: Callback<HistoryReadResult>
    ): void;
    public async readAggregateValue(
        nodeToRead: HistoryReadValueIdOptions,
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction,
        processingInterval: number,
        aggregateConfiguration: AggregateConfigurationOptions
    ): Promise<HistoryReadResult>;

    public readAggregateValue(
        arg0: HistoryReadValueIdOptions[] | HistoryReadValueIdOptions,
        startTime: DateTime,
        endTime: DateTime,
        aggregateFn: AggregateFunction[] | AggregateFunction,
        processingInterval: number,
        ...args: any[]
    ): any {
        const callback = typeof args[0] === "function" ? args[0] : args[1];
        assert(typeof callback === "function");
        const defaultAggregateFunction = {
            percentDataBad: 100,
            percentDataGood: 100,
            treatUncertainAsBad: true,
            useServerCapabilitiesDefaults: true,
            useSlopedExtrapolation: false
        };
        const aggregateConfiguration = typeof args[0] === "function" ? defaultAggregateFunction : args[0];

        const isArray = Array.isArray(arg0);

        const nodesToRead: HistoryReadValueIdOptions[] = isArray
            ? (arg0 as HistoryReadValueIdOptions[])
            : [arg0 as HistoryReadValueIdOptions];

        const aggregateFns: AggregateFunction[] = Array.isArray(aggregateFn)
            ? (aggregateFn as AggregateFunction[])
            : [aggregateFn as AggregateFunction];

        assert(aggregateFns.length === nodesToRead.length);

        const readProcessedDetails = new ReadProcessedDetails({
            aggregateType: aggregateFns,
            endTime,
            processingInterval,
            startTime,
            aggregateConfiguration
        });

        const request = new HistoryReadRequest({
            historyReadDetails: readProcessedDetails,
            nodesToRead,
            releaseContinuationPoints: false,
            timestampsToReturn: TimestampsToReturn.Both
        });

        assert(nodesToRead.length === request.nodesToRead!.length);
        this.performMessageTransaction(request, (err: Error | null, response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }

            /* istanbul ignore next */
            if (!response || !(response instanceof HistoryReadResponse)) {
                return callback(new Error("Internal Error"));
            }

            if (response.responseHeader.serviceResult.isNot(StatusCodes.Good)) {
                return callback(new Error(response.responseHeader.serviceResult.toString()));
            }

            response.results = response.results || /* istanbul ignore next */ [];

            assert(nodesToRead.length === response.results.length);

            callback(null, isArray ? response.results : response.results[0]);
        });
    }

    /**
     *

     * @param nodesToWrite {WriteValue[]}  - the array of value to write. One or more elements.
     * @param {Function} callback -   the callback function
     * @param callback.err {object|null} the error if write has failed or null if OK
     * @param callback.statusCodes {StatusCode[]} - an array of status code of each write
     *
     * @example
     *
     *     const nodesToWrite = [
     *     {
     *          nodeId: "ns=1;s=SetPoint1",
     *          attributeId: opcua.AttributeIds.Value,
     *          value: {
     *             statusCode: Good,
     *             value: {
     *               dataType: opcua.DataType.Double,
     *               value: 100.0
     *             }
     *          }
     *     },
     *     {
     *          nodeId: "ns=1;s=SetPoint2",
     *          attributeIds opcua.AttributeIds.Value,
     *          value: {
     *             statusCode: Good,
     *             value: {
     *               dataType: opcua.DataType.Double,
     *               value: 45.0
     *             }
     *          }
     *     }
     *     ];
     *     session.write(nodesToWrite,function (err,statusCodes) {
     *       if(err) { return callback(err);}
     *       //
     *     });
     *

     * @param nodeToWrite {WriteValue}  - the value to write
     * @param callback -   the callback function
     * @param callback.err {object|null} the error if write has failed or null if OK
     * @param callback.statusCode {StatusCodes} - the status code of the write
     *
     * @example
     *
     *     const nodeToWrite = {
     *          nodeId: "ns=1;s=SetPoint",
     *          attributeId: opcua.AttributeIds.Value,
     *          value: {
     *             statusCode: Good,
     *             value: {
     *               dataType: opcua.DataType.Double,
     *               value: 100.0
     *             }
     *          }
     *     };
     *     session.write(nodeToWrite,function (err,statusCode) {
     *       if(err) { return callback(err);}
     *       //
     *     });
     *
     *

     * @param nodeToWrite {WriteValue}  - the value to write
     * @return {Promise<StatusCode>}
     *
     * @example
     *
     * ```javascript
     *   session.write(nodeToWrite).then(function(statusCode) { });
     * ```
     *
     * @example
     *
     * ```javascript
     *   const statusCode = await session.write(nodeToWrite);
     * ```
     *

     * @param nodesToWrite {Array<WriteValue>}  - the value to write
     * @return {Promise<Array<StatusCode>>}
     *
     * @example
     * ```javascript
     * session.write(nodesToWrite).then(function(statusCodes) { });
     * ```
     *
     * @example
     * ```javascript
     *   const statusCodes = await session.write(nodesToWrite);
     * ```
     */
    public write(nodeToWrite: WriteValueOptions, callback: ResponseCallback<StatusCode>): void;

    public write(nodesToWrite: WriteValueOptions[], callback: ResponseCallback<StatusCode[]>): void;

    public async write(nodesToWrite: WriteValueOptions[]): Promise<StatusCode[]>;

    public async write(nodeToWrite: WriteValueOptions): Promise<StatusCode>;

    /**
     * @internal
     * @param args
     */
    public write(...args: any[]): any {
        const arg0 = args[0];
        const isArray = Array.isArray(arg0);
        const nodesToWrite = isArray ? arg0 : [arg0];

        const callback = args[1];
        assert(typeof callback === "function");

        const request = new WriteRequest({ nodesToWrite });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err, response);
            }

            /* istanbul ignore next */
            if (!response || !(response instanceof WriteResponse)) {
                return callback(new Error("Internal Error"));
            }

            /* istanbul ignore next */
            if (response.responseHeader.serviceResult.isNot(StatusCodes.Good)) {
                return callback(new Error(response.responseHeader.serviceResult.toString()));
            }
            response.results = response.results || /* istanbul ignore next */ [];
            assert(nodesToWrite.length === response.results.length);
            callback(null, isArray ? response.results : response.results[0]);
        });
    }

    /**
     * @deprecated use session.write instead
     *
     * @param nodeId  {NodeId}  - the node id of the node to write
     * @param value   {Variant} - the value to write
     * @param callback   {Function}
     * @param callback.err {object|null} the error if write has failed or null if OK
     * @param callback.statusCode {StatusCode} - the status code of the write
     *
     * @param nodeId  {NodeId}  - the node id of the node to write
     * @param value   {Variant} - the value to write
     * @return {Promise<StatusCode>} - the status code of the write
     *
     *
     * @example
     *     // please use session.write instead of session.writeSingleNode
     *     // as follow
     *     const statusCode = await session.write({
     *          nodeId,
     *          attributeId: AttributeIds.Value,
     *          value: {
     *             statusCode: Good,
     *             sourceTimestamp: new Date(), // optional, some server may not accept this
     *             value: {
     *               dataType: opcua.DataType.Double,
     *               value: 100.0
     *             }
     *          }
     *     });
     *
     *
     */
    public writeSingleNode(nodeId: NodeIdLike, value: VariantLike, callback: ResponseCallback<StatusCode>): void;

    public writeSingleNode(nodeId: NodeIdLike, value: VariantLike): Promise<StatusCode>;

    public writeSingleNode(...args: any[]): any {
        const nodeId = args[0] as NodeIdLike;
        const value = args[1] as VariantLike;
        const callback = args[2];

        assert(typeof callback === "function");

        const nodeToWrite = new WriteValue({
            attributeId: AttributeIds.Value,
            indexRange: undefined,
            nodeId: this.resolveNodeId(nodeId),
            value: new DataValue({ value })
        });

        this.write(nodeToWrite, (err, statusCode) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }
            assert(statusCode);
            callback(null, statusCode);
        });
    }

    /**

     *
     * @example
     *
     *
     *  ``` javascript
     *  session.readAllAttributes("ns=2;s=Furnace_1.Temperature",function(err,data) {
     *    if(data.statusCode.isGood()) {
     *      console.log(" nodeId      = ",data.nodeId.toString());
     *      console.log(" browseName  = ",data.browseName.toString());
     *      console.log(" description = ",data.description.toString());
     *      console.log(" value       = ",data.value.toString()));
     *    }
     *  });
     *  ```
     *
     * @param nodes  array of nodeId to read
     * @param node  nodeId to read
     * @param callback
     */
    public readAllAttributes(node: NodeIdLike, callback: (err: Error | null, data?: NodeAttributes) => void): void;

    public readAllAttributes(nodes: NodeIdLike[], callback: (err: Error | null, data?: NodeAttributes[]) => void): void;

    public readAllAttributes(...args: any[]): void {
        const nodes = args[0] as NodeIdLike[];
        const callback = args[1] as (err: Error | null, data?: NodeAttributes[]) => void;
        readAllAttributes(this, nodes)
            .then((data: any) => callback(null, data))
            .catch((err: Error) => callback(err));
    }

    /**
     *
     *
     * @example
     *
     *     ```javascript
     *     ```
     *
     *   form1: reading a single node
     *
     *  ``` javascript
     *    const nodeToRead = {
     *             nodeId:      "ns=2;s=Furnace_1.Temperature",
     *             attributeId: AttributeIds.BrowseName
     *    };
     *
     *    session.read(nodeToRead,function(err,dataValue) {
     *        if (!err) {
     *           console.log(dataValue.toString());
     *        }
     *    });
     *    ```
     *
     *

     * @param nodesToRead               {Array<ReadValueId>} - an array of nodeId to read or a ReadValueId
     * @param [maxAge]                 {Number}
     * @param callback                 {Function}                - the callback function
     * @param callback.err             {Error|null}              - the error or null if the transaction was OK}
     * @param callback.dataValues       {Array<DataValue>}
     *
     * @example
     *
     *   ``` javascript
     *   const nodesToRead = [
     *        {
     *             nodeId:      "ns=2;s=Furnace_1.Temperature",
     *             attributeId: AttributeIds.BrowseName
     *        }
     *   ];
     *   session.read(nodesToRead,function(err,dataValues) {
     *     if (!err) {
     *       dataValues.forEach(dataValue=>console.log(dataValue.toString()));
     *     }
     *   });
     *   ```
     *
     */
    public read(nodeToRead: ReadValueIdOptions, maxAge: number, callback: ResponseCallback<DataValue>): void;

    public read(nodesToRead: ReadValueIdOptions[], maxAge: number, callback: ResponseCallback<DataValue[]>): void;

    public read(nodeToRead: ReadValueIdOptions, callback: ResponseCallback<DataValue>): void;

    public read(nodesToRead: ReadValueIdOptions[], callback: ResponseCallback<DataValue[]>): void;

    public read(nodeToRead: ReadValueIdOptions, maxAge?: number): Promise<DataValue>;

    public read(nodeToRead: ReadValueIdOptions[], maxAge?: number): Promise<DataValue[]>;

    /**
     * @internal
     * @param args
     */
    public read(...args: any[]): any {
        if (args.length === 2) {
            return this.read(args[0], 0, args[1]);
        }
        assert(args.length === 3);

        const isArray = Array.isArray(args[0]);

        const nodesToRead = isArray ? args[0] : [args[0]];

        assert(Array.isArray(nodesToRead));

        const maxAge = args[1];

        const callback = args[2];
        assert(typeof callback === "function");

        /* istanbul ignore next */
        if (helpAPIChange) {
            // the read method deprecation detection and warning
            if (
                !(getFunctionParameterNames(callback)[1] === "dataValues" || getFunctionParameterNames(callback)[1] === "dataValue")
            ) {
                warningLog(chalk.red("[NODE-OPCUA-E04] the ClientSession#read  API has changed !!, please fix the client code"));
                warningLog(chalk.red("   replace ..:"));
                warningLog(chalk.cyan("   session.read(nodesToRead,function(err,nodesToRead,results) {}"));
                warningLog(chalk.red("   with .... :"));
                warningLog(chalk.cyan("   session.read(nodesToRead,function(err,dataValues) {}"));
                warningLog("");
                warningLog(
                    chalk.yellow(
                        "please make sure to refactor your code and check that " +
                            "the second argument of your callback function is named"
                    ),
                    chalk.cyan("dataValue" + (isArray ? "s" : ""))
                );
                warningLog(chalk.cyan("to make this exception disappear"));
                throw new Error("ERROR ClientSession#read  API has changed !!, please fix the client code");
            }
        }

        // coerce nodeIds
        for (const node of nodesToRead) {
            node.nodeId = this.resolveNodeId(node.nodeId);
        }

        const request = new ReadRequest({
            maxAge,
            nodesToRead,
            timestampsToReturn: TimestampsToReturn.Both
        });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err, response);
            }

            /* istanbul ignore next */
            if (!response || !(response instanceof ReadResponse)) {
                return callback(new Error("Internal Error"));
            }

            // perform ExtensionObject resolution
            promoteOpaqueStructure(this, response.results!).then(() => {
                response.results = response.results || /* istanbul ignore next */ [];
                callback(null, isArray ? response.results : response.results[0]);
            }).catch((err) => {
                callback(err);
            });
        });
    }

    public emitCloseEvent(statusCode: StatusCode): void {
        if (!this._closeEventHasBeenEmitted) {
            debugLog("ClientSession#emitCloseEvent");
            this._closeEventHasBeenEmitted = true;
            this.emit("session_closed", statusCode);
        }
    }

    public createSubscription(
        options: CreateSubscriptionRequestLike,
        callback?: ResponseCallback<CreateSubscriptionResponse>
    ): any {
        this._defaultRequest(CreateSubscriptionRequest, CreateSubscriptionResponse, options, callback);
    }

    /**

     * @param createSubscriptionRequest
     * @param callback
     *
     *
     * subscription.on("error',    function(err){ ... });
     * subscription.on("terminate',function(err){ ... });
     * const monitoredItem = await subscription.monitor(itemToMonitor,monitoringParameters,requestedParameters);
     * monitoredItem.on("changed",function( dataValue) {...});
     *
     */
    public async createSubscription2(createSubscriptionRequest: CreateSubscriptionRequestLike): Promise<ClientSubscription>;
    public createSubscription2(
        createSubscriptionRequest: CreateSubscriptionRequestLike,
        callback: (err: Error | null, subscription?: ClientSubscription) => void
    ): void;
    public createSubscription2(...args: any[]): any {
        const createSubscriptionRequest = args[0] as CreateSubscriptionRequestLike;
        let callback = args[1];
        const subscription = new ClientSubscriptionImpl(this, createSubscriptionRequest);

        // tslint:disable-next-line:no-empty
        subscription.on("error", (err) => {
            if (callback) {
                callback(err);
                callback = null;
            }
        });
        subscription.on("started", () => {
            assert(subscription.session === this, "expecting a session here");
            if (callback) {
                callback(null, subscription);
                callback = null;
            }
        });
    }

    public deleteSubscriptions(
        options: DeleteSubscriptionsRequestLike,
        callback?: ResponseCallback<DeleteSubscriptionsResponse>
    ): any {
        this._defaultRequest(DeleteSubscriptionsRequest, DeleteSubscriptionsResponse, options, callback);
    }

    public setTriggering(request: SetTriggeringRequestOptions, callback?: ResponseCallback<SetTriggeringResponse>): any {
        this._defaultRequest(SetTriggeringRequest, SetTriggeringResponse, request, callback);
    }

    /**
     */
    public transferSubscriptions(
        options: TransferSubscriptionsRequestLike,
        callback?: ResponseCallback<TransferSubscriptionsResponse>
    ): any {
        this._defaultRequest(TransferSubscriptionsRequest, TransferSubscriptionsResponse, options, callback);
    }

    public createMonitoredItems(
        options: CreateMonitoredItemsRequestLike,
        callback?: ResponseCallback<CreateMonitoredItemsResponse>
    ): any {
        this._defaultRequest(CreateMonitoredItemsRequest, CreateMonitoredItemsResponse, options, callback);
    }

    public modifyMonitoredItems(
        options: ModifyMonitoredItemsRequestLike,
        callback?: ResponseCallback<ModifyMonitoredItemsResponse>
    ): any {
        this._defaultRequest(ModifyMonitoredItemsRequest, ModifyMonitoredItemsResponse, options, callback);
    }

    /**
     *
     */
    public modifySubscription(
        options: ModifySubscriptionRequestLike,
        callback?: ResponseCallback<ModifySubscriptionResponse>
    ): any {
        this._defaultRequest(ModifySubscriptionRequest, ModifySubscriptionResponse, options, callback);
    }

    public setMonitoringMode(options: SetMonitoringModeRequestLike, callback?: ResponseCallback<SetMonitoringModeResponse>): any {
        this._defaultRequest(SetMonitoringModeRequest, SetMonitoringModeResponse, options, callback);
    }

    /**
     */
    public publish(options: PublishRequest, callback: (err: Error | null, response?: PublishResponse) => void): void {
        this._defaultRequest(PublishRequest, PublishResponse, options, callback);
    }

    /**
     *
     */
    public republish(options: RepublishRequest, callback: (err: Error | null, response?: RepublishResponse) => void): void {
        this._defaultRequest(RepublishRequest, RepublishResponse, options, callback);
    }

    /**
     *
     */
    public deleteMonitoredItems(
        options: DeleteMonitoredItemsRequestLike,
        callback: (err: Error | null, response?: DeleteMonitoredItemsResponse) => void
    ): void {
        this._defaultRequest(DeleteMonitoredItemsRequest, DeleteMonitoredItemsResponse, options, callback);
    }

    /**
     *
     */
    public setPublishingMode(publishingEnabled: boolean, subscriptionId: SubscriptionId): Promise<StatusCode>;
    public setPublishingMode(publishingEnabled: boolean, subscriptionIds: SubscriptionId[]): Promise<StatusCode[]>;
    public setPublishingMode(
        publishingEnabled: boolean,
        subscriptionId: SubscriptionId,
        callback: (err: Error | null, statusCode?: StatusCode) => void
    ): void;
    public setPublishingMode(
        publishingEnabled: boolean,
        subscriptionIds: SubscriptionId[],
        callback: (err: Error | null, statusCodes?: StatusCode[]) => void
    ): void;
    /**
     * @internal
     */
    public setPublishingMode(...args: any[]): any {
        const publishingEnabled = args[0];
        const isArray = Array.isArray(args[1]);
        const subscriptionIds = isArray ? args[1] : [args[1]];
        const callback = args[2];

        assert(typeof callback === "function");
        assert(publishingEnabled === true || publishingEnabled === false);

        const options = new SetPublishingModeRequest({
            publishingEnabled,
            subscriptionIds
        });

        this._defaultRequest(
            SetPublishingModeRequest,
            SetPublishingModeResponse,
            options,
            (err: Error | null, response?: SetPublishingModeResponse) => {
                /* istanbul ignore next */
                if (err) {
                    return callback(err);
                }
                /* istanbul ignore next */
                if (!response) {
                    return callback(new Error("Internal Error"));
                }
                response.results = response.results || /* istanbul ignore next */ [];
                callback(err, isArray ? response.results : response.results[0]);
            }
        );
    }

    /**
     *
     */
    public translateBrowsePath(browsePath: BrowsePath, callback: ResponseCallback<BrowsePathResult>): void;
    public translateBrowsePath(browsesPath: BrowsePath[], callback: ResponseCallback<BrowsePathResult[]>): void;
    public async translateBrowsePath(browsePath: BrowsePath): Promise<BrowsePathResult>;
    public async translateBrowsePath(browsePaths: BrowsePath[]): Promise<BrowsePathResult[]>;

    /**
     * @internal
     * @param args
     */
    public translateBrowsePath(...args: any[]): any {
        const isArray = Array.isArray(args[0]);
        const browsePaths = isArray ? args[0] : [args[0]];

        const callback = args[1];
        assert(typeof callback === "function");

        const request = new TranslateBrowsePathsToNodeIdsRequest({ browsePaths });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err, response);
            }
            /* istanbul ignore next */
            if (!response || !(response instanceof TranslateBrowsePathsToNodeIdsResponse)) {
                return callback(new Error("Internal Error"));
            }
            response.results = response.results || /* istanbul ignore next */ [];

            callback(null, isArray ? response.results : response.results[0]);
        });
    }

    public channelId(): number {
        return this._client !== null && this._client._secureChannel !== null && this._client._secureChannel.isOpened()
            ? this._client._secureChannel!.channelId
            : -1;
    }
    public isChannelValid(): boolean {
        /* istanbul ignore next */
        if (!this._client) {
            debugLog(chalk.red("Warning SessionClient is null ?"));
        }

        return this._client !== null && this._client._secureChannel !== null && this._client._secureChannel.isOpened();
    }

    public performMessageTransaction(request: Request, callback: (err: Error | null, response?: Response) => void): void {
        if (!this._client) {
            // session may have been closed by user ... but is still in used !!
            return callback(new Error("Session has been closed and should not be used to perform a transaction anymore"));
        }
        if (
            request instanceof PublishRequest ||
            request instanceof ActivateSessionRequest ||
            request instanceof CloseSessionRequest
        ) {
            return this._performMessageTransaction(request, callback);
        }

        if (this._reconnecting.pendingTransactions.length > 0) {
            /* istanbul ignore next */
            if (this._reconnecting.pendingTransactions.length > 10) {
                if (!pendingTransactionMessageDisplayed) {
                    pendingTransactionMessageDisplayed = true;
                    warningLog(
                        "[NODE-OPCUA-W21]",
                        "Pending transactions: ",
                        this._reconnecting.pendingTransactions.map((a: any) => a.request.constructor.name).join(" ")
                    );
                    warningLog(
                        "[NODE-OPCUA-W22]",
                        chalk.yellow(
                            "Warning : your opcua client is sending multiple requests simultaneously to the server",
                            request.constructor.name
                        ),
                        "\n",
                        chalk.yellow(" please fix your application code")
                    );
                }
            } else if (this._reconnecting.pendingTransactions.length > 3) {
                debugLog(
                    chalk.yellow(
                        "Warning : your client is sending multiple requests simultaneously to the server",
                        request.constructor.name
                    )
                );
            }
            this._reconnecting.pendingTransactions.push({ request, callback });
            return;
        }
        this.#reprocessRequest(0, request, callback);
    }
    #reprocessRequest(
        attemptCount: number,
        request: Request,
        callback: (err: Error | null, response?: Response) => void
    ): void {
        attemptCount > 0 &&
            warningLog("reprocessRequest => ", request.constructor.name, this._reconnecting.pendingTransactions.length);
        this._performMessageTransaction(request, (err: null | Error, response?: Response) => {
            if (err && err.message.match(/BadSessionIdInvalid/) && request.constructor.name !== "ActivateSessionRequest") {
                warningLog(
                    "Transaction on Invalid Session ",
                    request.constructor.name,
                    err.message,
                    "isReconnecting?=",
                    this.isReconnecting,
                    "q=",
                    this._reconnecting.pendingTransactions.length
                );
                request.requestHeader.requestHandle = requestHandleNotSetValue;
                if (this.isReconnecting) {
                    this.once("session_restored", () => {
                        warningLog("redoing", request.constructor.name, this.isReconnecting);
                        this.#reprocessRequest(attemptCount + 1, request, callback);
                    });
                } else {
                    this.#_recreate_session_and_reperform_transaction(request, callback);
                }
                return;
            }
            callback(err, response);
            const length = this._reconnecting.pendingTransactions.length; // record length before callback is called !
            if (length > 0) {
                debugLog("reprocessRequest => ", this._reconnecting.pendingTransactions.length, " transaction(s) left in queue");
                // tslint:disable-next-line: no-shadowed-variable
                const { request, callback } = this._reconnecting.pendingTransactions.shift();
                this.#reprocessRequest(0, request, callback);
            }
        });
    };

    public _performMessageTransaction(request: Request, callback: (err: Error | null, response?: Response) => void): void {
        assert(typeof callback === "function");

        /* istanbul ignore next */
        if (!this._client) {
            // session may have been closed by user ... but is still in used !!
            return callback(new Error("Session has been closed and should not be used to perform a transaction anymore"));
        }

        if (!this.isChannelValid()) {
            // the secure channel is broken, may be the server has crashed or the network cable has been disconnected
            // for a long time
            // we may need to queue this transaction, as a secure token may be being reprocessed
            debugLog(chalk.bgWhite.red("!!! Performing transaction on invalid channel !!! ", request.constructor.name));
            return callback(new Error("Invalid Channel BadConnectionClosed"));
        }

        // is this stuff useful?
        if (request.requestHeader) {
            request.requestHeader.authenticationToken = this.authenticationToken!;
        }

        this.lastRequestSentTime = new Date();

        this._client.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            this.lastResponseReceivedTime = new Date();

            /* istanbul ignore next */
            if (err) {
                if (response && response.responseHeader.serviceDiagnostics) {
                    (err as any).serviceDiagnostics = response.responseHeader.serviceDiagnostics;
                }
                if (response && (response as any).diagnosticInfos) {
                    (err as any).diagnosticsInfo = (response as any).diagnosticInfos;
                }
                return callback(err);
            }

            /* istanbul ignore next */
            if (!response) {
                return callback(new Error("internal Error"));
            }

            /* istanbul ignore next */
            if (response.responseHeader.serviceResult.isNot(StatusCodes.Good)) {
                err = new Error(
                    " ServiceResult is " +
                        response.responseHeader.serviceResult.toString() +
                        " request was " +
                        request.constructor.name
                );

                if (response && response.responseHeader.serviceDiagnostics) {
                    (err as any).serviceDiagnostics = response.responseHeader.serviceDiagnostics;
                }
                if (response && (response as any).diagnosticInfos) {
                    (err as any).diagnosticsInfo = (response as any).diagnosticInfos;
                }
                return callback(err, response);
            }
            return callback(null, response);
        });
    }

    /**
     *  evaluate the remaining time for the session
     *
     *
     * evaluate the time in milliseconds that the session will live
     * on the server end from now.
     * The remaining live time is calculated based on when the last message was sent to the server
     * and the session timeout.
     *
     * * In normal operation , when server and client communicates on a regular
     *   basis, evaluateRemainingLifetime will return a number slightly below
     *   session.timeout
     *
     * * when the client and server cannot communicate due to a network issue
     *   (or a server crash), evaluateRemainingLifetime returns the estimated number
     *   of milliseconds before the server (if not crash) will keep  the session alive
     *   on its end to allow a automatic reconnection with session.
     *
     * * When evaluateRemainingLifetime returns zero , this mean that
     *   the session has probably ended on the server side and will have to be recreated
     *   from scratch in case of a reconnection.
     *
     * @return the number of milliseconds before session expires
     */
    public evaluateRemainingLifetime(): number {
        const now = Date.now();
        const expiryTime = this.lastRequestSentTime.getTime() + this.timeout;
        return Math.max(0, expiryTime - now);
    }

    public _terminatePublishEngine(): void {
        if (this._publishEngine) {
            this._publishEngine.terminate();
            this._publishEngine = null;
        }
    }

    /**
     *
     */
    public close(callback: ErrorCallback): void;

    public close(deleteSubscription: boolean, callback: ErrorCallback): void;

    public async close(deleteSubscription?: boolean): Promise<void>;

    /**
     * @internal
     * @param args
     */
    public close(...args: any[]): any {
        if (arguments.length === 1) {
            return this.close(true, args[0]);
        }

        const deleteSubscription = args[0];
        const callback = args[1];

        assert(typeof callback === "function");
        assert(typeof deleteSubscription === "boolean");

        /* istanbul ignore next */
        if (!this._client) {
            debugLog("ClientSession#close : warning, client is already closed");
            return callback(); // already close ?
        }
        assert(this._client);

        this._terminatePublishEngine();
        this._client.closeSession(this, deleteSubscription, (err?: Error) => {
            debugLog("session Close err ", err ? err.message : "null");
            callback();
        });
    }

    /**

     * @return {Boolean}
     */
    public hasBeenClosed(): boolean {
        return isNullOrUndefined(this._client) || this._closed || this._closeEventHasBeenEmitted;
    }

    public async call(methodToCall: CallMethodRequestLike): Promise<CallMethodResult>;
    public async call(methodToCall: CallMethodRequestLike[]): Promise<CallMethodResult[]>;
    public call(methodToCall: CallMethodRequestLike, callback: ResponseCallback<CallMethodResult>): void;
    public call(methodsToCall: CallMethodRequestLike[], callback: ResponseCallback<CallMethodResult[]>): void;
    /**
     * @internal
     * @param args
     */
    public call(...args: any[]): any {
        const isArray = Array.isArray(args[0]);
        const methodsToCall = isArray ? args[0] : [args[0]];
        assert(Array.isArray(methodsToCall));

        const callback = args[1];

        // Note : The client has no explicit address space and therefore will struggle to
        //        access the method arguments signature.
        //        There are two methods that can be considered:
        //           - get the object definition by querying the server
        //           - load a fake address space to have some thing to query on our end
        // const request = this._client.factory.constructObjectId("CallRequest",{ methodsToCall: methodsToCall});
        const request = new CallRequest({ methodsToCall });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }

            /* istanbul ignore next */
            if (!response || !(response instanceof CallResponse)) {
                return callback(new Error("internal error"));
            }
            response.results = response.results || [];

            promoteOpaqueStructureForCall(this, response.results).then(() => {
                callback(null, isArray ? response.results : response.results![0]);
            }).catch((err) => {
                callback(err);
            });
        });
    }

    /**

     * @param subscriptionId {UInt32} the subscription Id to return
     * @param callback {Function}
     * @param callback.err {Error}
     * @param callback.monitoredItems the monitored Items
     * @param callback.monitoredItems the monitored Items
     */

    public async getMonitoredItems(subscriptionId: SubscriptionId): Promise<MonitoredItemData>;
    public getMonitoredItems(subscriptionId: SubscriptionId, callback: ResponseCallback<MonitoredItemData>): void;
    public getMonitoredItems(...args: any[]): any {
        const subscriptionId = args[0] as SubscriptionId;
        const callback = args[1];
        // <UAObject NodeId="i=2253"  BrowseName="Server">
        // <UAMethod NodeId="i=11492" BrowseName="GetMonitoredItems"
        //                                         ParentNodeId="i=2253" MethodDeclarationId="i=11489">
        // <UAMethod NodeId="i=11489" BrowseName="GetMonitoredItems" ParentNodeId="i=2004">
        const methodsToCall = new CallMethodRequest({
            inputArguments: [
                // BaseDataType
                { dataType: DataType.UInt32, value: subscriptionId }
            ],
            methodId: coerceNodeId("ns=0;i=11492"), // MethodIds.Server_GetMonitoredItems;
            objectId: coerceNodeId("ns=0;i=2253") // ObjectId.Server
        });

        this.call(methodsToCall, (err?: Error | null, result?: CallMethodResult) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }

            /* istanbul ignore next */
            if (!result) {
                return callback(new Error("internal error"));
            }

            /* istanbul ignore next */
            if (result.statusCode.isNot(StatusCodes.Good)) {
                callback(new Error(result.statusCode.toString()));
            } else {
                result.outputArguments = result.outputArguments || [];

                assert(result.outputArguments.length === 2);
                const data = {
                    clientHandles: result.outputArguments[1].value,
                    serverHandles: result.outputArguments[0].value //
                };

                // Note some server might return null array
                // let make sure we have Uint32Array and not a null pointer
                data.serverHandles = data.serverHandles || /* istanbul ignore next */ emptyUint32Array;
                data.clientHandles = data.clientHandles || /* istanbul ignore next */ emptyUint32Array;

                assert(data.serverHandles instanceof Uint32Array);
                assert(data.clientHandles instanceof Uint32Array);
                callback(null, data);
            }
        });
    }

    /**
     *
     */
    public async getArgumentDefinition(methodId: MethodId): Promise<ArgumentDefinition>;
    public getArgumentDefinition(methodId: MethodId, callback: ResponseCallback<ArgumentDefinition>): void;
    /**
     * @internal
     */
    public getArgumentDefinition(...args: any[]): any {
        const methodId = args[0] as MethodId;
        const callback = args[1] as ResponseCallback<ArgumentDefinition>;
        assert(typeof callback === "function");
        return getArgumentDefinitionHelper(this, methodId)
            .then((result) => {
                callback!(null, result);
            })
            .catch((err) => {
                callback(err);
            });
    }

    public async registerNodes(nodesToRegister: NodeIdLike[]): Promise<NodeId[]>;
    public registerNodes(nodesToRegister: NodeIdLike[], callback: (err: Error | null, registeredNodeIds?: NodeId[]) => void): void;
    public registerNodes(...args: any[]): any {
        const nodesToRegister = args[0] as NodeIdLike[];
        const callback = args[1] as (err: Error | null, registeredNodeIds?: NodeId[]) => void;

        assert(typeof callback === "function");
        assert(Array.isArray(nodesToRegister));

        const request = new RegisterNodesRequest({
            nodesToRegister: nodesToRegister.map((n) => this.resolveNodeId(n))
        });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }
            /* istanbul ignore next */
            if (!response || !(response instanceof RegisterNodesResponse)) {
                return callback(new Error("Internal Error"));
            }

            response.registeredNodeIds = response.registeredNodeIds || /* istanbul ignore next */ [];

            callback(null, response.registeredNodeIds);
        });
    }

    public async unregisterNodes(nodesToUnregister: NodeIdLike[]): Promise<void>;
    public unregisterNodes(nodesToUnregister: NodeIdLike[], callback: (err?: Error) => void): void;
    public unregisterNodes(...args: any[]): any {
        const nodesToUnregister = args[0] as NodeIdLike[];
        const callback = args[1] as (err?: Error) => void;

        assert(typeof callback === "function");
        assert(Array.isArray(nodesToUnregister));

        const request = new UnregisterNodesRequest({
            nodesToUnregister: nodesToUnregister.map((n) => this.resolveNodeId(n))
        });

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }
            /* istanbul ignore next */
            if (!response || !(response instanceof UnregisterNodesResponse)) {
                return callback(new Error("Internal Error"));
            }
            callback();
        });
    }

    public async queryFirst(queryFirstRequest: QueryFirstRequestLike): Promise<QueryFirstResponse>;

    public queryFirst(queryFirstRequest: QueryFirstRequestLike, callback: ResponseCallback<QueryFirstResponse>): void;
    public queryFirst(...args: any[]): any {
        const queryFirstRequest = args[0] as QueryFirstRequestLike;
        const callback = args[1] as ResponseCallback<QueryFirstResponse>;

        assert(typeof callback === "function");
        const request = new QueryFirstRequest(queryFirstRequest);

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }
            /* istanbul ignore next */
            if (!response || !(response instanceof QueryFirstResponse)) {
                return callback(new Error("internal error"));
            }
            callback(null, response);
        });
    }

    public startKeepAliveManager(keepAliveInterval?: number): void {
        if (this._keepAliveManager) {
            //  "keepAliveManger already started"
            return;
        }
        this._keepAliveManager = new ClientSessionKeepAliveManager(this);

        this._keepAliveManager.on("failure", () => {
            /**
             * raised when a keep-alive request has failed on the session, may be the session has timeout
             * unexpectedly on the server side, may be the connection is broken.
             * @event keepalive_failure
             */
            this.emit("keepalive_failure");
        });
        this._keepAliveManager.on("keepalive", (state, count) => {
            /**
             * @event keepalive
             */
            this.emit("keepalive", state, count);
        });
        this._keepAliveManager.start(keepAliveInterval);
    }

    public stopKeepAliveManager(): void {
        if (this._keepAliveManager) {
            this._keepAliveManager.stop();
            this._keepAliveManager = undefined;
        }
    }

    public dispose(): void {
        assert(this._closeEventHasBeenEmitted);
        this._terminatePublishEngine();
        this.stopKeepAliveManager();
        this.removeAllListeners();
        //
        const privateThis = this as any;
        if (!(!privateThis.pendingTransactions || privateThis.pendingTransactions.length === 0)) {
            // tslint:disable-next-line: no-console
            warningLog("dispose when pendingTransactions is not empty ");
        }
    }

    public toString(): string {
        const now = Date.now();
        const lap1 = now - this.lastRequestSentTime.getTime();
        const lap2 = now - this.lastResponseReceivedTime.getTime();
        const timeoutDelay = this.timeout - lap1;

        const timeoutInfo =
            timeoutDelay < 0
                ? chalk.red(" expired since " + -timeoutDelay / 1000 + " seconds")
                : chalk.green(" timeout in " + timeoutDelay / 1000 + " seconds");

        let str = "";
        str += " name..................... " + this.name;
        str += "\n sessionId................ " + this.sessionId.toString();
        str += "\n authenticationToken...... " + (this.authenticationToken ? this.authenticationToken!.toString() : "");
        str += "\n timeout.................. " + this.timeout + "ms" + timeoutInfo;
        str += "\n serverNonce.............. " + (this.serverNonce ? this.serverNonce!.toString("hex") : "");
        str += "\n serverCertificate........ " + buffer_ellipsis(this.serverCertificate);
        str += "\n serverSignature.......... " + this.serverSignature;
        str += "\n lastRequestSentTime...... " + new Date(this.lastRequestSentTime).toISOString() + "  (" + lap1 + ")";
        str += "\n lastResponseReceivedTime. " + new Date(this.lastResponseReceivedTime).toISOString() + " (" + lap2 + ")";
        str += "\n isReconnecting........... " + this.isReconnecting;
        str += "\n isValidChannel........... " + this.isChannelValid() + " has been closed  " + this.hasBeenClosed();
        str += "\n channelId................ " + this.channelId();
        str += "\n remaining life time...... " + this.evaluateRemainingLifetime();
        str += "\n subscription count....... " + this.subscriptionCount;
        if (this._client && this._client._secureChannel) {
            if (this._client._secureChannel.activeSecurityToken) {
                str += "\n reviseTokenLifetime...... " + this._client._secureChannel.activeSecurityToken.revisedLifetime;
            }
        }
        str += "\n keepAlive ................ " + this._keepAliveManager ? true : false;
        if (this._keepAliveManager) {
            str += "\n keepAlive checkInterval.. " + this._keepAliveManager.checkInterval + " ms";
            str += "\n (defaultTransportTimeout)." + ClientSecureChannelLayer.defaultTransportTimeout + " ms";
            str += "\n session timeout           " + this.timeout + " ms";
        }
        return str;
    }

    public getBuiltInDataType(...args: any[]): any {
        const nodeId = args[0];
        const callback = args[1];
        return getBuiltInDataType(this, nodeId)
            .then((dataType: DataType) => callback(null, dataType))
            .catch(callback);
    }

    public async readNamespaceArray(): Promise<string[]>;
    public readNamespaceArray(callback: (err: Error | null, namespaceArray?: string[]) => void): void;
    public readNamespaceArray(...args: any[]): any {
        const callback = args[0];
        readNamespaceArray(this)
            .then((namespaceArray) => callback(null, namespaceArray))
            .catch((err) => {
                callback(err);
            });
    }

    public getNamespaceIndex(namespaceUri: string): number {
        assert(this.$$namespaceArray, "please make sure that readNamespaceArray has been called");
        return this.$$namespaceArray!.indexOf(namespaceUri);
    }

    // tslint:disable:no-empty
    // ---------------------------------------- Alarm & condition stub
    public disableCondition(): void {
        /** empty */
    }

    public enableCondition(): void {
        /** empty */
    }

    public addCommentCondition(
        _conditionId: NodeIdLike,
        _eventId: Buffer,
        _comment: LocalizedTextLike,
        _callback?: Callback<StatusCode>
    ): any {
        /** empty */
    }

    public confirmCondition(
        _conditionId: NodeIdLike,
        _eventId: Buffer,
        _comment: LocalizedTextLike,
        _callback?: Callback<StatusCode>
    ): any {
        /** empty */
    }

    public acknowledgeCondition(
        _conditionId: NodeId,
        _eventId: Buffer,
        _comment: LocalizedTextLike,
        _callback?: Callback<StatusCode>
    ): any {
        /** empty */
    }

    /**
     * @deprecated
     * @private
     */
    public findMethodId(_nodeId: NodeIdLike, _methodName: string, _callback?: ResponseCallback<NodeId>): any {
        /** empty */
    }

    public _callMethodCondition(
        _methodName: string,
        _conditionId: NodeIdLike,
        _eventId: Buffer,
        _comment: LocalizedTextLike,
        _callback: Callback<StatusCode>
    ): void {
        /** empty */
    }

    public async extractNamespaceDataType(): Promise<ExtraDataTypeManager> {
        return getExtraDataTypeManager(this);
    }
    public async getExtensionObjectConstructor(dataTypeNodeId: NodeId): Promise<AnyConstructorFunc> {
        return getExtensionObjectConstructor(this, dataTypeNodeId);
    }
    /**
     * construct a Extension object from a DataType and a pojo
     * @param dataType
     * @param pojo
     */
    public async constructExtensionObject(dataType: NodeId, pojo: Record<string, any>): Promise<ExtensionObject> {
        const Constructor = await this.getExtensionObjectConstructor(dataType);
        return new Constructor(pojo);
    }

    private _defaultRequest(requestClass: any, _responseClass: any, options: any, callback: any) {
        assert(typeof callback === "function");

        const request = options instanceof requestClass ? options : new requestClass(options);

        /* istanbul ignore next */
        if (doDebug) {
            request.trace = new Error("").stack;
        }

        /* istanbul ignore next */
        if (this._closeEventHasBeenEmitted) {
            debugLog("ClientSession#_defaultRequest => session has been closed !!", request.toString());
            setImmediate(() => {
                callback(new Error("ClientSession is closed !"));
            });
            return;
        }

        this.performMessageTransaction(request, (err: Error | null, response?: Response) => {
            if (this._closeEventHasBeenEmitted) {
                debugLog(
                    "ClientSession#_defaultRequest ... err =",
                    err ? err.message : "null",
                    response ? response.toString() : " null"
                );
            }
            /* istanbul ignore next */
            if (err) {
                debugLog("Client session : performMessageTransaction error = ", err.message);
                // let intercept interesting error message
                if (err.message.match(/BadSessionClosed/)) {
                    // the session has been closed by Server
                    // probably due to timeout issue
                    // let's print some statistics
                    const now = Date.now();

                    /* istanbul ignore next */
                    if (doDebug) {
                        debugLog(chalk.bgWhite.red(" server send BadSessionClosed !"));
                        debugLog(chalk.bgWhite.red(" request was               "), request.toString());
                        debugLog(" timeout.................. ", this.timeout);
                        debugLog(
                            " lastRequestSentTime...... ",
                            new Date(this.lastRequestSentTime).toISOString(),
                            now - this.lastRequestSentTime.getTime()
                        );
                        debugLog(
                            " lastResponseReceivedTime. ",
                            new Date(this.lastResponseReceivedTime).toISOString(),
                            now - this.lastResponseReceivedTime.getTime()
                        );
                    }

                    //  DO NOT TERMINATE SESSION, as we will need a publishEngine when we
                    //  reconnect this._terminatePublishEngine();

                    if (false) {
                        // ER 10.2019
                        /**
                         * send when the session has been closed by the server ( probably due to inactivity and timeout)
                         * @event session_closed
                         */
                        this.emitCloseEvent(StatusCodes.BadSessionClosed);
                    }
                }
                return callback(err, response);
            }
            callback(null, response);
        });
    }
    #_recreate_session_and_reperform_transaction(request: Request, callback: (err: Error | null, response?: Response) => void) {
        warningLog("attempt to recreate session to reperform a transaction ", request.constructor.name);
        if (this.recursive_repair_detector >= 1) {
            // tslint:disable-next-line: no-console
            warningLog("recreate_session_and_reperform_transaction => Already in Progress");
            return callback(new Error("Cannot recreate session"));
        }
        this.recursive_repair_detector += 1;
        warningLog(chalk.red("----------------> Repairing Client Session as Server believes it is invalid now "));
        repair_client_session(this._client!, this, (err?: Error) => {
            this.recursive_repair_detector -= 1;
            if (err) {
                warningLog(chalk.red("----------------> session Repaired has failed with error", err.message));
                return callback(err);
            }
            warningLog(chalk.red("----------------> session Repaired, now redoing original transaction "));
            this._performMessageTransaction(request, callback);
        });
    }
}

async function promoteOpaqueStructureForCallMethodResult(session: IBasicSessionAsync2, callMethodResult: CallMethodResult): Promise<void> {
    if (!callMethodResult || !callMethodResult.outputArguments || callMethodResult.outputArguments.length === 0) {
        return;
    }
    await promoteOpaqueStructure(
        session,
        callMethodResult.outputArguments.map((a) => ({ value: a }))
    );
}

function countOpaqueStructures(callMethodResults: CallMethodResult[]): number {
    const x = (a: Variant[] | null): PseudoDataValue[] => {
        if (a === null) return [] as PseudoDataValue[];
        return a.map((value) => {
            return { value: value };
        });
    };
    const opaqueStructureCount = callMethodResults.reduce((prev, callMethodResult) => {
        return prev + extractDataValueToPromote(x(callMethodResult.outputArguments)).length;
    }, 0);
    return opaqueStructureCount;
}

async function promoteOpaqueStructureForCall(session: IBasicSessionAsync2, callMethodResults: CallMethodResult[]): Promise<void> {
    const opaqueStructureCount = countOpaqueStructures(callMethodResults);
    if (0 === opaqueStructureCount) return;

    // construct dataTypeManager if not already present
    await getExtraDataTypeManager(session);

    const promises: Promise<void>[] = callMethodResults.map(async (x: CallMethodResult) => promoteOpaqueStructureForCallMethodResult(session, x));
    await Promise.all(promises);
}

// tslint:disable:no-var-requires
// tslint:disable:max-line-length
import { withCallback } from "thenify-ex";
const opts = { multiArgs: false };

ClientSessionImpl.prototype.browse = withCallback(ClientSessionImpl.prototype.browse, opts);
ClientSessionImpl.prototype.browseNext = withCallback(ClientSessionImpl.prototype.browseNext, opts);
ClientSessionImpl.prototype.readVariableValue = withCallback(ClientSessionImpl.prototype.readVariableValue, opts);
ClientSessionImpl.prototype.readHistoryValue = withCallback(ClientSessionImpl.prototype.readHistoryValue, opts);
ClientSessionImpl.prototype.readAggregateValue = withCallback(ClientSessionImpl.prototype.readAggregateValue, opts);
ClientSessionImpl.prototype.historyRead = withCallback(ClientSessionImpl.prototype.historyRead, opts);
ClientSessionImpl.prototype.write = withCallback(ClientSessionImpl.prototype.write, opts);
ClientSessionImpl.prototype.writeSingleNode = withCallback(ClientSessionImpl.prototype.writeSingleNode, opts);
ClientSessionImpl.prototype.readAllAttributes = withCallback(ClientSessionImpl.prototype.readAllAttributes, opts);
ClientSessionImpl.prototype.read = withCallback(ClientSessionImpl.prototype.read, opts);
ClientSessionImpl.prototype.createSubscription = withCallback(ClientSessionImpl.prototype.createSubscription, opts);
ClientSessionImpl.prototype.createSubscription2 = withCallback(ClientSessionImpl.prototype.createSubscription2, opts);
ClientSessionImpl.prototype.deleteSubscriptions = withCallback(ClientSessionImpl.prototype.deleteSubscriptions, opts);
ClientSessionImpl.prototype.transferSubscriptions = withCallback(ClientSessionImpl.prototype.transferSubscriptions, opts);
ClientSessionImpl.prototype.createMonitoredItems = withCallback(ClientSessionImpl.prototype.createMonitoredItems, opts);
ClientSessionImpl.prototype.modifyMonitoredItems = withCallback(ClientSessionImpl.prototype.modifyMonitoredItems, opts);
ClientSessionImpl.prototype.modifySubscription = withCallback(ClientSessionImpl.prototype.modifySubscription, opts);
ClientSessionImpl.prototype.setTriggering = withCallback(ClientSessionImpl.prototype.setTriggering, opts);
ClientSessionImpl.prototype.setMonitoringMode = withCallback(ClientSessionImpl.prototype.setMonitoringMode, opts);
ClientSessionImpl.prototype.publish = withCallback(ClientSessionImpl.prototype.publish, opts);
ClientSessionImpl.prototype.republish = withCallback(ClientSessionImpl.prototype.republish, opts);
ClientSessionImpl.prototype.deleteMonitoredItems = withCallback(ClientSessionImpl.prototype.deleteMonitoredItems, opts);
ClientSessionImpl.prototype.setPublishingMode = withCallback(ClientSessionImpl.prototype.setPublishingMode, opts);
ClientSessionImpl.prototype.translateBrowsePath = withCallback(ClientSessionImpl.prototype.translateBrowsePath, opts);
ClientSessionImpl.prototype.performMessageTransaction = withCallback(
    ClientSessionImpl.prototype.performMessageTransaction,
    opts
);
ClientSessionImpl.prototype.close = withCallback(ClientSessionImpl.prototype.close, opts);
ClientSessionImpl.prototype.call = withCallback(ClientSessionImpl.prototype.call, opts);
ClientSessionImpl.prototype.getMonitoredItems = withCallback(ClientSessionImpl.prototype.getMonitoredItems, opts);
ClientSessionImpl.prototype.getArgumentDefinition = withCallback(ClientSessionImpl.prototype.getArgumentDefinition, opts);
ClientSessionImpl.prototype.queryFirst = withCallback(ClientSessionImpl.prototype.queryFirst, opts);
ClientSessionImpl.prototype.registerNodes = withCallback(ClientSessionImpl.prototype.registerNodes, opts);
ClientSessionImpl.prototype.unregisterNodes = withCallback(ClientSessionImpl.prototype.unregisterNodes, opts);
ClientSessionImpl.prototype.readNamespaceArray = withCallback(ClientSessionImpl.prototype.readNamespaceArray, opts);
ClientSessionImpl.prototype.getBuiltInDataType = withCallback(ClientSessionImpl.prototype.getBuiltInDataType, opts);
ClientSessionImpl.prototype.changeUser = withCallback(ClientSessionImpl.prototype.changeUser, opts);
