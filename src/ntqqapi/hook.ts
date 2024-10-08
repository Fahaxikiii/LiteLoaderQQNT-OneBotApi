import type { BrowserWindow } from 'electron'
import { NTQQApiClass, NTQQApiMethod } from './ntcall'
import { NTQQMsgApi } from './api/msg'
import {
  CategoryFriend,
  ChatType,
  GroupMember,
  GroupMemberRole,
  RawMessage,
  SimpleInfo, User,
} from './types'
import {
  friends,
  getFriend,
  getGroupMember,
  setSelfInfo
} from '@/common/data'
import { postOb11Event } from '../onebot11/server/post-ob11-event'
import { getConfigUtil, HOOK_LOG } from '@/common/config'
import fs from 'node:fs'
import { log } from '@/common/utils'
import { randomUUID } from 'node:crypto'
import { MessageUnique } from '../common/utils/MessageUnique'
import { isNumeric, sleep } from '@/common/utils'
import { OB11Constructor } from '../onebot11/constructor'
import { OB11GroupCardEvent } from '../onebot11/event/notice/OB11GroupCardEvent'
import { OB11GroupAdminNoticeEvent } from '../onebot11/event/notice/OB11GroupAdminNoticeEvent'

export let hookApiCallbacks: Record<string, (apiReturn: any) => void> = {}

export let ReceiveCmdS = {
  RECENT_CONTACT: 'nodeIKernelRecentContactListener/onRecentContactListChangedVer2',
  UPDATE_MSG: 'nodeIKernelMsgListener/onMsgInfoListUpdate',
  UPDATE_ACTIVE_MSG: 'nodeIKernelMsgListener/onActiveMsgInfoUpdate',
  NEW_MSG: `nodeIKernelMsgListener/onRecvMsg`,
  NEW_ACTIVE_MSG: `nodeIKernelMsgListener/onRecvActiveMsg`,
  SELF_SEND_MSG: 'nodeIKernelMsgListener/onAddSendMsg',
  USER_INFO: 'nodeIKernelProfileListener/onProfileSimpleChanged',
  USER_DETAIL_INFO: 'nodeIKernelProfileListener/onProfileDetailInfoChanged',
  GROUPS: 'nodeIKernelGroupListener/onGroupListUpdate',
  GROUPS_STORE: 'onGroupListUpdate',
  GROUP_MEMBER_INFO_UPDATE: 'nodeIKernelGroupListener/onMemberInfoChange',
  FRIENDS: 'onBuddyListChange',
  MEDIA_DOWNLOAD_COMPLETE: 'nodeIKernelMsgListener/onRichMediaDownloadComplete',
  UNREAD_GROUP_NOTIFY: 'nodeIKernelGroupListener/onGroupNotifiesUnreadCountUpdated',
  GROUP_NOTIFY: 'nodeIKernelGroupListener/onGroupSingleScreenNotifies',
  FRIEND_REQUEST: 'nodeIKernelBuddyListener/onBuddyReqChange',
  SELF_STATUS: 'nodeIKernelProfileListener/onSelfStatusChanged',
  CACHE_SCAN_FINISH: 'nodeIKernelStorageCleanListener/onFinishScan',
  MEDIA_UPLOAD_COMPLETE: 'nodeIKernelMsgListener/onRichMediaUploadComplete',
  SKEY_UPDATE: 'onSkeyUpdate',
}

export type ReceiveCmd = (typeof ReceiveCmdS)[keyof typeof ReceiveCmdS]

interface NTQQApiReturnData<PayloadType = unknown> extends Array<any> {
  0: {
    type: 'request'
    eventName: NTQQApiClass
    callbackId?: string
  }
  1: {
    cmdName: ReceiveCmd
    cmdType: 'event'
    payload: PayloadType
  }[]
}

let receiveHooks: Array<{
  method: ReceiveCmd[]
  hookFunc: (payload: any) => void | Promise<void>
  id: string
}> = []

let callHooks: Array<{
  method: NTQQApiMethod[]
  hookFunc: (callParams: unknown[]) => void | Promise<void>
}> = []

export function hookNTQQApiReceive(window: BrowserWindow) {
  const originalSend = window.webContents.send
  const patchSend = (channel: string, ...args: NTQQApiReturnData) => {
    // console.log("hookNTQQApiReceive", channel, args)
    let isLogger = false
    try {
      isLogger = args[0]?.eventName?.startsWith('ns-LoggerApi')
    } catch (e) { }
    if (!isLogger) {
      try {
        HOOK_LOG && log(`received ntqq api message: ${channel}`, args)
      } catch (e) {
        log('hook log error', e, args)
      }
    }
    try {
      if (args?.[1] instanceof Array) {
        for (let receiveData of args?.[1]) {
          const ntQQApiMethodName = receiveData.cmdName
          // log(`received ntqq api message: ${channel} ${ntQQApiMethodName}`, JSON.stringify(receiveData))
          for (let hook of receiveHooks) {
            if (hook.method.includes(ntQQApiMethodName)) {
              new Promise((resolve, reject) => {
                try {
                  let _ = hook.hookFunc(receiveData.payload)
                  if (hook.hookFunc.constructor.name === 'AsyncFunction') {
                    ; (_ as Promise<void>).then()
                  }
                } catch (e: any) {
                  log('hook error', ntQQApiMethodName, e.stack.toString())
                }
              }).then()
            }
          }
        }
      }
      if (args[0]?.callbackId) {
        // log("hookApiCallback", hookApiCallbacks, args)
        const callbackId = args[0].callbackId
        if (hookApiCallbacks[callbackId]) {
          // log("callback found")
          new Promise((resolve, reject) => {
            hookApiCallbacks[callbackId](args[1])
          }).then()
          delete hookApiCallbacks[callbackId]
        }
      }
    } catch (e: any) {
      log('hookNTQQApiReceive error', e.stack.toString(), args)
    }
    originalSend.call(window.webContents, channel, ...args)
  }
  window.webContents.send = patchSend
}

export function hookNTQQApiCall(window: BrowserWindow) {
  // 监听调用NTQQApi
  let webContents = window.webContents as any
  const ipc_message_proxy = webContents._events['-ipc-message']?.[0] || webContents._events['-ipc-message']

  const proxyIpcMsg = new Proxy(ipc_message_proxy, {
    apply(target, thisArg, args) {
      // console.log(thisArg, args);
      let isLogger = false
      try {
        isLogger = args[3][0].eventName.startsWith('ns-LoggerApi')
      } catch (e) { }
      if (!isLogger) {
        try {
          HOOK_LOG && log('call NTQQ api', thisArg, args)
        } catch (e) { }
        try {
          const _args: unknown[] = args[3][1]
          const cmdName: NTQQApiMethod = _args[0] as NTQQApiMethod
          const callParams = _args.slice(1)
          callHooks.forEach((hook) => {
            if (hook.method.includes(cmdName)) {
              new Promise((resolve, reject) => {
                try {
                  let _ = hook.hookFunc(callParams)
                  if (hook.hookFunc.constructor.name === 'AsyncFunction') {
                    (_ as Promise<void>).then()
                  }
                } catch (e) {
                  log('hook call error', e, _args)
                }
              }).then()
            }
          })
        } catch (e) { }
      }
      return target.apply(thisArg, args)
    },
  })
  if (webContents._events['-ipc-message']?.[0]) {
    webContents._events['-ipc-message'][0] = proxyIpcMsg
  } else {
    webContents._events['-ipc-message'] = proxyIpcMsg
  }

  const ipc_invoke_proxy = webContents._events['-ipc-invoke']?.[0] || webContents._events['-ipc-invoke']
  const proxyIpcInvoke = new Proxy(ipc_invoke_proxy, {
    apply(target, thisArg, args) {
      // console.log(args);
      HOOK_LOG && log('call NTQQ invoke api', thisArg, args)
      args[0]['_replyChannel']['sendReply'] = new Proxy(args[0]['_replyChannel']['sendReply'], {
        apply(sendtarget, sendthisArg, sendargs) {
          sendtarget.apply(sendthisArg, sendargs)
        },
      })
      let ret = target.apply(thisArg, args)
      try {
        HOOK_LOG && log('call NTQQ invoke api return', ret)
      } catch (e) { }
      return ret
    },
  })
  if (webContents._events['-ipc-invoke']?.[0]) {
    webContents._events['-ipc-invoke'][0] = proxyIpcInvoke
  } else {
    webContents._events['-ipc-invoke'] = proxyIpcInvoke
  }
}

export function registerReceiveHook<PayloadType>(
  method: ReceiveCmd | ReceiveCmd[],
  hookFunc: (payload: PayloadType) => void,
): string {
  const id = randomUUID()
  if (!Array.isArray(method)) {
    method = [method]
  }
  receiveHooks.push({
    method,
    hookFunc,
    id,
  })
  return id
}

export function registerCallHook(
  method: NTQQApiMethod | NTQQApiMethod[],
  hookFunc: (callParams: unknown[]) => void | Promise<void>,
): void {
  if (!Array.isArray(method)) {
    method = [method]
  }
  callHooks.push({
    method,
    hookFunc,
  })
}

export function removeReceiveHook(id: string) {
  const index = receiveHooks.findIndex((h) => h.id === id)
  receiveHooks.splice(index, 1)
}

//let activatedGroups: string[] = []

/*async function updateGroups(_groups: Group[], needUpdate: boolean = true) {
  for (let group of _groups) {
    log('update group', group.groupCode)
    if (group.privilegeFlag === 0) {
      deleteGroup(group.groupCode)
      continue
    }
    //log('update group', group)
    NTQQMsgApi.activateChat({ peerUid: group.groupCode, chatType: ChatType.group }).then().catch(log)
    let existGroup = groups.find((g) => g.groupCode == group.groupCode)
    if (existGroup) {
      Object.assign(existGroup, group)
    } else {
      groups.push(group)
      existGroup = group
    }

    if (needUpdate) {
      const members = await NTQQGroupApi.getGroupMembers(group.groupCode)

      if (members) {
        existGroup.members = Array.from(members.values())
      }
    }
  }
}*/

/*async function processGroupEvent(payload: { groupList: Group[] }) {
  try {
    const newGroupList = payload.groupList
    for (const group of newGroupList) {
      let existGroup = groups.find((g) => g.groupCode == group.groupCode)
      if (existGroup) {
        if (existGroup.memberCount > group.memberCount) {
          log(`群(${group.groupCode})成员数量减少${existGroup.memberCount} -> ${group.memberCount}`)
          const oldMembers = existGroup.members

          await sleep(200) // 如果请求QQ API的速度过快，通常无法正确拉取到最新的群信息，因此这里人为引入一个延时
          const newMembers = await NTQQGroupApi.getGroupMembers(group.groupCode)

          group.members = Array.from(newMembers.values())
          const newMembersSet = new Set<string>() // 建立索引降低时间复杂度

          for (const member of newMembers) {
            newMembersSet.add(member[1].uin)
          }

          // 判断bot是否是管理员，如果是管理员不需要从这里得知有人退群，这里的退群无法得知是主动退群还是被踢
          const selfUin = getSelfUin()
          const bot = await getGroupMember(group.groupCode, selfUin)
          if (bot?.role == GroupMemberRole.admin || bot?.role == GroupMemberRole.owner) {
            continue
          }
          for (const member of oldMembers) {
            if (!newMembersSet.has(member.uin) && member.uin != selfUin) {
              postOb11Event(
                new OB11GroupDecreaseEvent(
                  parseInt(group.groupCode),
                  parseInt(member.uin),
                  parseInt(member.uin),
                  'leave',
                ),
              )
              break
            }
          }
        }
        if (group.privilegeFlag === 0) {
          deleteGroup(group.groupCode)
        }
      }
    }

    updateGroups(newGroupList, false).then()
  } catch (e: any) {
    updateGroups(payload.groupList).then()
    log('更新群信息错误', e.stack.toString())
  }
}*/

export async function startHook() {

  // 群列表变动
  /*registerReceiveHook<{ groupList: Group[]; updateType: number }>(ReceiveCmdS.GROUPS, (payload) => {
    // updateType 3是群列表变动，2是群成员变动
    // log("群列表变动", payload.updateType, payload.groupList)
    if (payload.updateType != 2) {
      updateGroups(payload.groupList).then()
    }
    else {
      if (process.platform == 'win32') {
        processGroupEvent(payload).then()
      }
    }
  })
  registerReceiveHook<{ groupList: Group[]; updateType: number }>(ReceiveCmdS.GROUPS_STORE, (payload) => {
    // updateType 3是群列表变动，2是群成员变动
    // log("群列表变动, store", payload.updateType, payload.groupList)
    if (payload.updateType != 2) {
      updateGroups(payload.groupList).then()
    }
    else {
      if (process.platform != 'win32') {
        processGroupEvent(payload).then()
      }
    }
  })*/

  registerReceiveHook<{
    groupCode: string
    dataSource: number
    members: Set<GroupMember>
  }>(ReceiveCmdS.GROUP_MEMBER_INFO_UPDATE, async (payload) => {
    const groupCode = payload.groupCode
    const members = Array.from(payload.members.values())
    // log("群成员信息变动", groupCode, members)
    for (const member of members) {
      const existMember = await getGroupMember(groupCode, member.uin)
      if (existMember) {
        if (member.cardName != existMember.cardName) {
          log('群成员名片变动', `${groupCode}: ${existMember.uin}`, existMember.cardName, '->', member.cardName)
          postOb11Event(
            new OB11GroupCardEvent(parseInt(groupCode), parseInt(member.uin), member.cardName, existMember.cardName),
          )
        } else if (member.role != existMember.role) {
          log('有管理员变动通知')
          const groupAdminNoticeEvent = new OB11GroupAdminNoticeEvent(
            member.role == GroupMemberRole.admin ? 'set' : 'unset',
            parseInt(groupCode),
            parseInt(member.uin)
          )
          postOb11Event(groupAdminNoticeEvent, true)
        }
        Object.assign(existMember, member)
      }
    }
    // const existGroup = groups.find(g => g.groupCode == groupCode);
    // if (existGroup) {
    //     log("对比群成员", existGroup.members, members)
    //     for (const member of members) {
    //         const existMember = existGroup.members.find(m => m.uin == member.uin);
    //         if (existMember) {
    //             log("对比群名片", existMember.cardName, member.cardName)
    //             if (existMember.cardName != member.cardName) {
    //                 postOB11Event(new OB11GroupCardEvent(parseInt(existGroup.groupCode), parseInt(member.uin), member.cardName, existMember.cardName));
    //             }
    //             Object.assign(existMember, member);
    //         }
    //     }
    // }
  })

  // 好友列表变动
  registerReceiveHook<{
    data: CategoryFriend[]
  }>(ReceiveCmdS.FRIENDS, (payload) => {
    // log("onBuddyListChange", payload)
    // let friendListV2: {userSimpleInfos: Map<string, SimpleInfo>} = []
    type V2data = {userSimpleInfos: Map<string, SimpleInfo>}
    let friendList: User[] = [];
    if ((payload as any).userSimpleInfos) {
      // friendListV2 = payload as any
      friendList = Object.values((payload as unknown as V2data).userSimpleInfos).map((v: SimpleInfo) => {
        return {
          ...v.coreInfo,
        }
      })
    }
    else{
      for (const fData of payload.data) {
        friendList.push(...fData.buddyList)
      }
    }
    log('好友列表变动', friendList)
    for (let friend of friendList) {
      NTQQMsgApi.activateChat({ peerUid: friend.uid, chatType: ChatType.friend }).then()
      let existFriend = friends.find((f) => f.uin == friend.uin)
      if (!existFriend) {
        friends.push(friend)
      }
      else {
        Object.assign(existFriend, friend)
      }
    }
  })

  registerReceiveHook<{ msgList: Array<RawMessage> }>([ReceiveCmdS.NEW_MSG, ReceiveCmdS.NEW_ACTIVE_MSG], (payload) => {
    // 自动清理新消息文件
    const { autoDeleteFile } = getConfigUtil().getConfig()
    if (!autoDeleteFile) {
      return
    }
    for (const message of payload.msgList) {
      // log("收到新消息，push到历史记录", message.msgId)
      // dbUtil.addMsg(message).then()
      // 清理文件

      for (const msgElement of message.elements) {
        setTimeout(() => {
          const picPath = msgElement.picElement?.sourcePath
          const picThumbPath = [...msgElement.picElement?.thumbPath.values()]
          const pttPath = msgElement.pttElement?.filePath
          const filePath = msgElement.fileElement?.filePath
          const videoPath = msgElement.videoElement?.filePath
          const videoThumbPath: string[] = [...msgElement.videoElement.thumbPath?.values()!]
          const pathList = [picPath, ...picThumbPath, pttPath, filePath, videoPath, ...videoThumbPath]
          if (msgElement.picElement) {
            pathList.push(...Object.values(msgElement.picElement.thumbPath))
          }

          // log("需要清理的文件", pathList);
          for (const path of pathList) {
            if (path) {
              fs.unlink(picPath, () => {
                log('删除文件成功', path)
              })
            }
          }
        }, getConfigUtil().getConfig().autoDeleteFileSecond! * 1000)
      }
    }
  })

  registerReceiveHook<{ msgRecord: RawMessage }>(ReceiveCmdS.SELF_SEND_MSG, ({ msgRecord }) => {
    const { msgId, chatType, peerUid } = msgRecord
    const peer = {
      chatType,
      peerUid
    }
    MessageUnique.createMsg(peer, msgId)
  })

  registerReceiveHook<{ info: { status: number } }>(ReceiveCmdS.SELF_STATUS, (info) => {
    setSelfInfo({
      online: info.info.status !== 20
    })
  })

  let activatedPeerUids: string[] = []
  registerReceiveHook<{
    changedRecentContactLists: {
      listType: number
      sortedContactList: string[]
      changedList: {
        id: string // peerUid
        chatType: ChatType
      }[]
    }[]
  }>(ReceiveCmdS.RECENT_CONTACT, async (payload) => {
    for (const recentContact of payload.changedRecentContactLists) {
      for (const changedContact of recentContact.changedList) {
        if (activatedPeerUids.includes(changedContact.id)) continue
        activatedPeerUids.push(changedContact.id)
        const peer = { peerUid: changedContact.id, chatType: changedContact.chatType }
        if (changedContact.chatType === ChatType.temp) {
          log('收到临时会话消息', peer)
          NTQQMsgApi.activateChatAndGetHistory(peer).then(() => {
            NTQQMsgApi.getMsgHistory(peer, '', 20).then(({ msgList }) => {
              let lastTempMsg = msgList.pop()
              log('激活窗口之前的第一条临时会话消息:', lastTempMsg)
              if (Date.now() / 1000 - parseInt(lastTempMsg?.msgTime!) < 5) {
                OB11Constructor.message(lastTempMsg!).then((r) => postOb11Event(r))
              }
            })
          })
        }
        else {
          NTQQMsgApi.activateChat(peer).then()
        }
      }
    }
  })

  registerCallHook(NTQQApiMethod.DELETE_ACTIVE_CHAT, async (payload) => {
    const peerUid = payload[0] as string
    log('激活的聊天窗口被删除，准备重新激活', peerUid)
    let chatType = ChatType.friend
    if (isNumeric(peerUid)) {
      chatType = ChatType.group
    }
    else {
      // 检查是否好友
      if (!(await getFriend(peerUid))) {
        chatType = ChatType.temp
      }
    }
    const peer = { peerUid, chatType }
    await sleep(1000)
    NTQQMsgApi.activateChat(peer).then((r) => {
      log('重新激活聊天窗口', peer, { result: r.result, errMsg: r.errMsg })
    })
  })
}
