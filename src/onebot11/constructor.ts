import fastXmlParser from 'fast-xml-parser'
import {
  OB11Group,
  OB11GroupMember,
  OB11GroupMemberRole,
  OB11Message,
  OB11MessageData,
  OB11MessageDataType,
  OB11User,
  OB11UserSex,
} from './types'
import {
  AtType,
  ChatType,
  FaceIndex,
  GrayTipElementSubType,
  Group,
  Peer,
  GroupMember,
  RawMessage,
  SelfInfo,
  Sex,
  TipGroupElementType,
  User,
  FriendV2,
  ChatType2
} from '../ntqqapi/types'
import { getGroupMember, getSelfUin } from '../common/data'
import { EventType } from './event/OB11BaseEvent'
import { encodeCQCode } from './cqcode'
import { MessageUnique } from '../common/utils/MessageUnique'
import { OB11GroupIncreaseEvent } from './event/notice/OB11GroupIncreaseEvent'
import { OB11GroupBanEvent } from './event/notice/OB11GroupBanEvent'
import { OB11GroupUploadNoticeEvent } from './event/notice/OB11GroupUploadNoticeEvent'
import { OB11GroupNoticeEvent } from './event/notice/OB11GroupNoticeEvent'
import { calcQQLevel } from '../common/utils/qqlevel'
import { log } from '../common/utils/log'
import { isNull, sleep } from '../common/utils/helper'
import { getConfigUtil } from '../common/config'
import { OB11GroupTitleEvent } from './event/notice/OB11GroupTitleEvent'
import { OB11GroupCardEvent } from './event/notice/OB11GroupCardEvent'
import { OB11GroupDecreaseEvent } from './event/notice/OB11GroupDecreaseEvent'
import { NTQQGroupApi, NTQQUserApi, NTQQFileApi, NTQQMsgApi } from '../ntqqapi/api'
import { OB11GroupMsgEmojiLikeEvent } from './event/notice/OB11MsgEmojiLikeEvent'
import { mFaceCache } from '../ntqqapi/constructor'
import { OB11FriendAddNoticeEvent } from './event/notice/OB11FriendAddNoticeEvent'
import { OB11FriendRecallNoticeEvent } from './event/notice/OB11FriendRecallNoticeEvent'
import { OB11GroupRecallNoticeEvent } from './event/notice/OB11GroupRecallNoticeEvent'
import { OB11FriendPokeEvent, OB11GroupPokeEvent } from './event/notice/OB11PokeEvent'
import { OB11BaseNoticeEvent } from './event/notice/OB11BaseNoticeEvent'
import { OB11GroupEssenceEvent } from './event/notice/OB11GroupEssenceEvent'

export class OB11Constructor {
  static async message(msg: RawMessage): Promise<OB11Message> {
    let config = getConfigUtil().getConfig()
    const {
      enableLocalFile2Url,
      debug,
      ob11: { messagePostFormat },
    } = config
    const selfUin = getSelfUin()
    const resMsg: OB11Message = {
      self_id: parseInt(selfUin),
      user_id: parseInt(msg.senderUin!),
      time: parseInt(msg.msgTime) || Date.now(),
      message_id: msg.msgShortId!,
      real_id: msg.msgShortId!,
      message_seq: msg.msgShortId!,
      message_type: msg.chatType === ChatType.group ? 'group' : 'private',
      sender: {
        user_id: parseInt(msg.senderUin!),
        nickname: msg.sendNickName,
        card: msg.sendMemberName || '',
      },
      raw_message: '',
      font: 14,
      sub_type: 'friend',
      message: messagePostFormat === 'string' ? '' : [],
      message_format: messagePostFormat === 'string' ? 'string' : 'array',
      post_type: selfUin == msg.senderUin ? EventType.MESSAGE_SENT : EventType.MESSAGE,
    }
    if (debug) {
      resMsg.raw = msg
    }
    if (msg.chatType == ChatType.group) {
      resMsg.sub_type = 'normal'
      resMsg.group_id = parseInt(msg.peerUin)
      const member = await getGroupMember(msg.peerUin, msg.senderUin!)
      if (member) {
        resMsg.sender.role = OB11Constructor.groupMemberRole(member.role)
        resMsg.sender.nickname = member.nick
      }
    }
    else if (msg.chatType == ChatType.friend) {
      resMsg.sub_type = 'friend'
      resMsg.sender.nickname = (await NTQQUserApi.getUserDetailInfo(msg.senderUid)).nick
    }
    else if (msg.chatType as unknown as ChatType2 == ChatType2.KCHATTYPETEMPC2CFROMGROUP) {
      resMsg.sub_type = 'group'
      const ret = await NTQQMsgApi.getTempChatInfo(ChatType2.KCHATTYPETEMPC2CFROMGROUP, msg.senderUid)
      if (ret.result === 0) {
        resMsg.group_id = parseInt(ret.tmpChatInfo!.groupCode)
        resMsg.sender.nickname = ret.tmpChatInfo!.fromNick
      } else {
        resMsg.group_id = 284840486 //兜底数据
        resMsg.sender.nickname = '临时会话'
      }
    }

    for (let element of msg.elements) {
      let message_data: OB11MessageData = {
        data: {} as any,
        type: 'unknown' as any,
      }
      if (element.textElement && element.textElement?.atType !== AtType.notAt) {
        let qq: string
        let name: string | undefined
        if (element.textElement.atType == AtType.atAll) {
          qq = 'all'
        }
        else {
          const { atNtUid, content } = element.textElement
          let atQQ = element.textElement.atUid
          if (!atQQ || atQQ === '0') {
            const atMember = await getGroupMember(msg.peerUin, atNtUid)
            if (atMember) {
              atQQ = atMember.uin
            }
          }
          if (atQQ) {
            qq = atQQ
            name = content.replace('@', '')
          }
        }
        message_data = {
          type: OB11MessageDataType.at,
          data: {
            qq: qq!,
            name
          }
        }
      }
      else if (element.textElement) {
        message_data['type'] = OB11MessageDataType.text
        let text = element.textElement.content
        if (!text.trim()) {
          continue
        }
        message_data['data']['text'] = text
      }
      else if (element.replyElement) {
        message_data['type'] = OB11MessageDataType.reply
        try {
          const records = msg.records.find(msgRecord => msgRecord.msgId === element.replyElement.sourceMsgIdInRecords)
          if (!records) throw new Error('找不到回复消息')
          let replyMsg = (await NTQQMsgApi.getMsgsBySeqAndCount({
            peerUid: msg.peerUid,
            guildId: '',
            chatType: msg.chatType,
          }, element.replyElement.replayMsgSeq, 1, true, true)).msgList[0]
          if (!replyMsg || records.msgRandom !== replyMsg.msgRandom) {
            const peer = {
              chatType: msg.chatType,
              peerUid: msg.peerUid,
              guildId: '',
            }
            replyMsg = (await NTQQMsgApi.getSingleMsg(peer, element.replyElement.replayMsgSeq)).msgList[0]
          }
          // 284840486: 合并消息内侧 消息具体定位不到
          if ((!replyMsg || records.msgRandom !== replyMsg.msgRandom) && msg.peerUin !== '284840486') {
            throw new Error('回复消息消息验证失败')
          }
          message_data['data']['id'] = MessageUnique.createMsg({
            peerUid: msg.peerUid,
            guildId: '',
            chatType: msg.chatType,
          }, replyMsg.msgId)?.toString()
        } catch (e: any) {
          log('获取不到引用的消息', e.stack, element.replyElement.replayMsgSeq)
          continue
        }
      }
      else if (element.picElement) {
        message_data['type'] = OB11MessageDataType.image
        const { picElement } = element
        /*let fileName = picElement.fileName
        const isGif = picElement.picType === PicType.gif
        if (isGif && !fileName.endsWith('.gif')) {
          fileName += '.gif'
        }*/
        message_data['data']['file'] = picElement.fileName
        message_data['data']['subType'] = picElement.picSubType
        //message_data['data']['file_id'] = picElement.fileUuid
        message_data['data']['url'] = await NTQQFileApi.getImageUrl(picElement)
        message_data['data']['file_size'] = picElement.fileSize
        MessageUnique.addFileCache({
          peerUid: msg.peerUid,
          msgId: msg.msgId,
          msgTime: +msg.msgTime,
          chatType: msg.chatType,
          elementId: element.elementId,
          elementType: element.elementType,
          fileName: picElement.fileName,
          fileSize: String(picElement.fileSize || '0'),
          fileUuid: picElement.fileUuid
        })
      }
      else if (element.videoElement) {
        message_data['type'] = OB11MessageDataType.video
        const { videoElement } = element
        message_data['data']['file'] = videoElement.fileName
        message_data['data']['path'] = videoElement.filePath
        //message_data['data']['file_id'] = videoElement.fileUuid
        message_data['data']['file_size'] = videoElement.fileSize
        message_data['data']['url'] = await NTQQFileApi.getVideoUrl({
          chatType: msg.chatType,
          peerUid: msg.peerUid,
        }, msg.msgId, element.elementId)
        MessageUnique.addFileCache({
          peerUid: msg.peerUid,
          msgId: msg.msgId,
          msgTime: +msg.msgTime,
          chatType: msg.chatType,
          elementId: element.elementId,
          elementType: element.elementType,
          fileName: videoElement.fileName,
          fileSize: String(videoElement.fileSize || '0'),
          fileUuid: videoElement.fileUuid!
        })
      }
      else if (element.fileElement) {
        message_data['type'] = OB11MessageDataType.file
        const { fileElement } = element
        message_data['data']['file'] = fileElement.fileName
        message_data['data']['path'] = fileElement.filePath
        message_data['data']['file_id'] = fileElement.fileUuid
        message_data['data']['file_size'] = fileElement.fileSize
        MessageUnique.addFileCache({
          peerUid: msg.peerUid,
          msgId: msg.msgId,
          msgTime: +msg.msgTime,
          chatType: msg.chatType,
          elementId: element.elementId,
          elementType: element.elementType,
          fileName: fileElement.fileName,
          fileSize: String(fileElement.fileSize || '0'),
          fileUuid: fileElement.fileUuid!
        })
      }
      else if (element.pttElement) {
        message_data['type'] = OB11MessageDataType.voice
        const { pttElement } = element
        message_data['data']['file'] = pttElement.fileName
        message_data['data']['path'] = pttElement.filePath
        //message_data['data']['file_id'] = pttElement.fileUuid
        message_data['data']['file_size'] = pttElement.fileSize
        MessageUnique.addFileCache({
          peerUid: msg.peerUid,
          msgId: msg.msgId,
          msgTime: +msg.msgTime,
          chatType: msg.chatType,
          elementId: element.elementId,
          elementType: element.elementType,
          fileName: pttElement.fileName,
          fileSize: String(pttElement.fileSize || '0'),
          fileUuid: pttElement.fileUuid
        })
      }
      else if (element.arkElement) {
        message_data['type'] = OB11MessageDataType.json
        message_data['data']['data'] = element.arkElement.bytesData
      }
      else if (element.faceElement) {
        const faceId = element.faceElement.faceIndex
        if (faceId === FaceIndex.dice) {
          message_data['type'] = OB11MessageDataType.dice
          message_data['data']['result'] = element.faceElement.resultId
        }
        else if (faceId === FaceIndex.RPS) {
          message_data['type'] = OB11MessageDataType.RPS
          message_data['data']['result'] = element.faceElement.resultId
        }
        else {
          message_data['type'] = OB11MessageDataType.face
          message_data['data']['id'] = element.faceElement.faceIndex.toString()
        }
      }
      else if (element.marketFaceElement) {
        message_data['type'] = OB11MessageDataType.mface
        message_data['data']['summary'] = element.marketFaceElement.faceName
        const md5 = element.marketFaceElement.emojiId
        // 取md5的前两位
        const dir = md5.substring(0, 2)
        // 获取组装url
        // const url = `https://p.qpic.cn/CDN_STATIC/0/data/imgcache/htdocs/club/item/parcel/item/${dir}/${md5}/300x300.gif?max_age=31536000`
        const url = `https://gxh.vip.qq.com/club/item/parcel/item/${dir}/${md5}/raw300.gif`
        message_data['data']['url'] = url
        message_data['data']['emoji_id'] = element.marketFaceElement.emojiId
        message_data['data']['emoji_package_id'] = String(element.marketFaceElement.emojiPackageId)
        message_data['data']['key'] = element.marketFaceElement.key
        mFaceCache.set(md5, element.marketFaceElement.faceName!)
      }
      else if (element.markdownElement) {
        message_data['type'] = OB11MessageDataType.markdown
        message_data['data']['data'] = element.markdownElement.content
      }
      else if (element.multiForwardMsgElement) {
        message_data['type'] = OB11MessageDataType.forward
        message_data['data']['id'] = msg.msgId
      }
      if ((message_data.type as string) !== 'unknown' && message_data.data) {
        const cqCode = encodeCQCode(message_data)
        if (messagePostFormat === 'string') {
          (resMsg.message as string) += cqCode
        }
        else (resMsg.message as OB11MessageData[]).push(message_data)

        resMsg.raw_message += cqCode
      }
    }
    resMsg.raw_message = resMsg.raw_message.trim()
    return resMsg
  }

  static async PrivateEvent(msg: RawMessage): Promise<OB11BaseNoticeEvent | void> {
    if (msg.chatType !== ChatType.friend) {
      return
    }
    for (const element of msg.elements) {
      if (element.grayTipElement) {
        if (element.grayTipElement.subElementType == GrayTipElementSubType.MEMBER_NEW_TITLE) {
          const json = JSON.parse(element.grayTipElement.jsonGrayTipElement.jsonStr)
          if (element.grayTipElement.jsonGrayTipElement.busiId == 1061) {
            //判断业务类型
            //Poke事件
            const pokedetail: any[] = json.items
            //筛选item带有uid的元素
            const poke_uid = pokedetail.filter(item => item.uid)
            if (poke_uid.length == 2) {
              return new OB11FriendPokeEvent(
                parseInt(await NTQQUserApi.getUinByUid(poke_uid[0].uid)),
                parseInt(await NTQQUserApi.getUinByUid(poke_uid[1].uid)),
                pokedetail
              )
            }
          }
          //下面得改 上面也是错的grayTipElement.subElementType == GrayTipElementSubType.MEMBER_NEW_TITLE
        }
      }
    }
    // 好友增加事件
    if (msg.msgType === 5 && msg.subMsgType === 12) {
      const event = new OB11FriendAddNoticeEvent(parseInt(msg.peerUin))
      return event
    }
  }

  static async GroupEvent(msg: RawMessage): Promise<OB11GroupNoticeEvent | void> {
    if (msg.chatType !== ChatType.group) {
      return
    }
    if (msg.senderUin) {
      let member = await getGroupMember(msg.peerUid, msg.senderUin)
      if (member && member.cardName !== msg.sendMemberName) {
        const event = new OB11GroupCardEvent(
          parseInt(msg.peerUid),
          parseInt(msg.senderUin),
          msg.sendMemberName!,
          member.cardName,
        )
        member.cardName = msg.sendMemberName!
        return event
      }
    }
    // log("group msg", msg)
    for (let element of msg.elements) {
      const grayTipElement = element.grayTipElement
      const groupElement = grayTipElement?.groupElement
      if (groupElement) {
        // log("收到群提示消息", groupElement)
        if (groupElement.type === TipGroupElementType.memberIncrease) {
          log('收到群成员增加消息', groupElement)
          await sleep(1000)
          const member = await getGroupMember(msg.peerUid, groupElement.memberUid)
          let memberUin = member?.uin
          if (!memberUin) {
            memberUin = (await NTQQUserApi.getUserDetailInfo(groupElement.memberUid)).uin
          }
          // log("获取新群成员QQ", memberUin)
          const adminMember = await getGroupMember(msg.peerUid, groupElement.adminUid)
          // log("获取同意新成员入群的管理员", adminMember)
          if (memberUin) {
            const operatorUin = adminMember?.uin || memberUin
            let event = new OB11GroupIncreaseEvent(parseInt(msg.peerUid), parseInt(memberUin), parseInt(operatorUin))
            // log("构造群增加事件", event)
            return event
          }
        }
        else if (groupElement.type === TipGroupElementType.ban) {
          log('收到群群员禁言提示', groupElement)
          const memberUid = groupElement.shutUp?.member.uid
          const adminUid = groupElement.shutUp?.admin.uid
          let memberUin: string = ''
          let duration = parseInt(groupElement.shutUp?.duration!)
          let sub_type: 'ban' | 'lift_ban' = duration > 0 ? 'ban' : 'lift_ban'
          if (memberUid) {
            memberUin =
              (await getGroupMember(msg.peerUid, memberUid))?.uin ||
              (await NTQQUserApi.getUserDetailInfo(memberUid))?.uin
          }
          else {
            memberUin = '0' // 0表示全员禁言
            if (duration > 0) {
              duration = -1
            }
          }
          const adminUin =
            (await getGroupMember(msg.peerUid, adminUid!))?.uin || (await NTQQUserApi.getUserDetailInfo(adminUid!))?.uin
          if (memberUin && adminUin) {
            return new OB11GroupBanEvent(
              parseInt(msg.peerUid),
              parseInt(memberUin),
              parseInt(adminUin),
              duration,
              sub_type,
            )
          }
        }
        else if (groupElement.type === TipGroupElementType.kicked) {
          log(`收到我被踢出或退群提示, 群${msg.peerUid}`, groupElement)
          NTQQGroupApi.quitGroup(msg.peerUid).then()
          try {
            const adminUin = (await getGroupMember(msg.peerUid, groupElement.adminUid))?.uin || (await NTQQUserApi.getUidByUin(groupElement.adminUid))
            if (adminUin) {
              return new OB11GroupDecreaseEvent(
                parseInt(msg.peerUid),
                parseInt(getSelfUin()),
                parseInt(adminUin),
                'kick_me'
              )
            }
          } catch (e) {
            return new OB11GroupDecreaseEvent(
              parseInt(msg.peerUid),
              parseInt(getSelfUin()),
              0,
              'leave'
            )
          }
        }
      }
      else if (element.fileElement) {
        return new OB11GroupUploadNoticeEvent(parseInt(msg.peerUid), parseInt(msg.senderUin!), {
          id: element.fileElement.fileUuid!,
          name: element.fileElement.fileName,
          size: parseInt(element.fileElement.fileSize),
          busid: element.fileElement.fileBizId || 0,
        })
      }

      if (grayTipElement) {
        const xmlElement = grayTipElement.xmlElement

        if (xmlElement?.templId === '10382') {
          // 表情回应消息
          // "content":
          //  "<gtip align=\"center\">
          //    <qq uin=\"u_snYxnEfja-Po_\" col=\"3\" jp=\"3794\"/>
          //    <nor txt=\"回应了你的\"/>
          //    <url jp= \"\" msgseq=\"74711\" col=\"3\" txt=\"消息:\"/>
          //    <face type=\"1\" id=\"76\">  </face>
          //  </gtip>",
          const emojiLikeData = new fastXmlParser.XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '',
          }).parse(xmlElement.content)
          log('收到表情回应我的消息', emojiLikeData)
          try {
            const senderUin = emojiLikeData.gtip.qq.jp
            const msgSeq = emojiLikeData.gtip.url.msgseq
            const emojiId = emojiLikeData.gtip.face.id
            const replyMsgList = (await NTQQMsgApi.getMsgsBySeqAndCount({
              chatType: ChatType.group,
              guildId: '',
              peerUid: msg.peerUid,
            }, msgSeq, 1, true, true)).msgList
            if (replyMsgList.length < 1) {
              return
            }
            const likes = [
              {
                emoji_id: emojiId,
                count: 1,
              },
            ]
            const shortId = MessageUnique.getShortIdByMsgId(replyMsgList[0].msgId)
            return new OB11GroupMsgEmojiLikeEvent(
              parseInt(msg.peerUid),
              parseInt(senderUin),
              shortId!,
              likes
            )
          } catch (e: any) {
            log('解析表情回应消息失败', e.stack)
          }
        }

        if (
          grayTipElement.subElementType == GrayTipElementSubType.INVITE_NEW_MEMBER &&
          xmlElement?.templId == '10179'
        ) {
          log('收到新人被邀请进群消息', grayTipElement)
          if (xmlElement?.content) {
            const regex = /jp="(\d+)"/g

            const matches: string[] = []
            let match: RegExpExecArray | null = null

            while ((match = regex.exec(xmlElement.content)) !== null) {
              matches.push(match[1])
            }
            // log("新人进群匹配到的QQ号", matches)
            if (matches.length === 2) {
              const [inviter, invitee] = matches
              return new OB11GroupIncreaseEvent(parseInt(msg.peerUid), parseInt(invitee), parseInt(inviter), 'invite')
            }
          }
        }
        else if (grayTipElement.subElementType == GrayTipElementSubType.MEMBER_NEW_TITLE) {
          const json = JSON.parse(grayTipElement.jsonGrayTipElement.jsonStr)
          /*
          {
            align: 'center',
            items: [
              { txt: '恭喜', type: 'nor' },
              {
                col: '3',
                jp: '5',
                param: ["QQ号"],
                txt: '林雨辰',
                type: 'url'
              },
              { txt: '获得群主授予的', type: 'nor' },
              {
                col: '3',
                jp: '',
                txt: '好好好',
                type: 'url'
              },
              { txt: '头衔', type: 'nor' }
            ]
          }

          * */
          if (grayTipElement.jsonGrayTipElement.busiId == 1061) {
            //判断业务类型
            //Poke事件
            const pokedetail: any[] = json.items
            //筛选item带有uid的元素
            const poke_uid = pokedetail.filter(item => item.uid)
            if (poke_uid.length == 2) {
              return new OB11GroupPokeEvent(
                parseInt(msg.peerUid),
                parseInt(await NTQQUserApi.getUinByUid(poke_uid[0].uid)),
                parseInt(await NTQQUserApi.getUinByUid(poke_uid[1].uid)),
                pokedetail
              )
            }
          }
          if (grayTipElement.jsonGrayTipElement.busiId == 2401) {
            log('收到群精华消息', json)
            const searchParams = new URL(json.items[0].jp).searchParams
            const msgSeq = searchParams.get('msgSeq')!
            const Group = searchParams.get('groupCode')
            const Peer: Peer = {
              guildId: '',
              chatType: ChatType.group,
              peerUid: Group!
            }
            const { msgList } = await NTQQMsgApi.getMsgsBySeqAndCount(Peer, msgSeq.toString(), 1, true, true)
            //const origMsg = await dbUtil.getMsgByLongId(msgList[0].msgId)
            //const postMsg = await dbUtil.getMsgBySeqId(origMsg?.msgSeq!) ?? origMsg
            // 如果 senderUin 为 0，可能是 历史消息 或 自身消息
            //if (msgList[0].senderUin === '0') {
            //msgList[0].senderUin = postMsg?.senderUin ?? getSelfUin()
            //}
            return new OB11GroupEssenceEvent(
              parseInt(msg.peerUid),
              MessageUnique.getShortIdByMsgId(msgList[0].msgId)!,
              parseInt(msgList[0].senderUin!)
            )
            // 获取MsgSeq+Peer可获取具体消息
          }
          if (grayTipElement.jsonGrayTipElement.busiId == 2407) {
            const memberUin = json.items[1].param[0]
            const title = json.items[3].txt
            log('收到群成员新头衔消息', json)
            getGroupMember(msg.peerUid, memberUin).then(member => {
              if (!isNull(member)) {
                member.memberSpecialTitle = title
              }
            })
            return new OB11GroupTitleEvent(parseInt(msg.peerUid), parseInt(memberUin), title)
          }
        }
      }
    }
  }

  static async RecallEvent(
    msg: RawMessage,
    shortId: number
  ): Promise<OB11FriendRecallNoticeEvent | OB11GroupRecallNoticeEvent | undefined> {
    const msgElement = msg.elements.find(
      (element) => element.grayTipElement?.subElementType === GrayTipElementSubType.RECALL,
    )
    if (!msgElement) {
      return
    }
    const revokeElement = msgElement.grayTipElement.revokeElement
    if (msg.chatType === ChatType.group) {
      const operator = await getGroupMember(msg.peerUid, revokeElement.operatorUid)
      return new OB11GroupRecallNoticeEvent(
        parseInt(msg.peerUid),
        parseInt(msg.senderUin!),
        parseInt(operator?.uin || msg.senderUin!),
        shortId,
      )
    }
    else {
      return new OB11FriendRecallNoticeEvent(parseInt(msg.senderUin!), shortId)
    }
  }

  static friend(friend: User): OB11User {
    return {
      user_id: parseInt(friend.uin),
      nickname: friend.nick,
      remark: friend.remark,
      sex: OB11Constructor.sex(friend.sex!),
      level: (friend.qqLevel && calcQQLevel(friend.qqLevel)) || 0,
    }
  }

  static selfInfo(selfInfo: SelfInfo): OB11User {
    return {
      user_id: parseInt(selfInfo.uin),
      nickname: selfInfo.nick,
    }
  }

  static friends(friends: User[]): OB11User[] {
    return friends.map(OB11Constructor.friend)
  }

  static friendsV2(friends: FriendV2[]): OB11User[] {
    const data: OB11User[] = []
    for (const friend of friends) {
      const sexValue = this.sex(friend.baseInfo.sex!)
      data.push({
        ...friend.baseInfo,
        ...friend.coreInfo,
        user_id: parseInt(friend.coreInfo.uin),
        nickname: friend.coreInfo.nick,
        remark: friend.coreInfo.nick,
        sex: sexValue,
        level: 0,
        categroyName: friend.categroyName,
        categoryId: friend.categoryId
      })
    }
    return data
  }

  static groupMemberRole(role: number): OB11GroupMemberRole | undefined {
    return {
      4: OB11GroupMemberRole.owner,
      3: OB11GroupMemberRole.admin,
      2: OB11GroupMemberRole.member,
    }[role]
  }

  static sex(sex: Sex): OB11UserSex {
    const sexMap = {
      [Sex.male]: OB11UserSex.male,
      [Sex.female]: OB11UserSex.female,
      [Sex.unknown]: OB11UserSex.unknown,
    }
    return sexMap[sex] || OB11UserSex.unknown
  }

  static groupMember(group_id: string, member: GroupMember): OB11GroupMember {
    return {
      group_id: parseInt(group_id),
      user_id: parseInt(member.uin),
      nickname: member.nick,
      card: member.cardName,
      sex: OB11Constructor.sex(member.sex!),
      age: 0,
      area: '',
      level: '0',
      qq_level: (member.qqLevel && calcQQLevel(member.qqLevel)) || 0,
      join_time: 0, // 暂时没法获取
      last_sent_time: 0, // 暂时没法获取
      title_expire_time: 0,
      unfriendly: false,
      card_changeable: true,
      is_robot: member.isRobot,
      shut_up_timestamp: member.shutUpTime,
      role: OB11Constructor.groupMemberRole(member.role),
      title: member.memberSpecialTitle || '',
    }
  }

  static stranger(user: User): OB11User {
    return {
      ...user,
      user_id: parseInt(user.uin),
      nickname: user.nick,
      sex: OB11Constructor.sex(user.sex!),
      age: 0,
      qid: user.qid,
      login_days: 0,
      level: (user.qqLevel && calcQQLevel(user.qqLevel)) || 0,
    }
  }

  static groupMembers(group: Group): OB11GroupMember[] {
    log('construct ob11 group members', group)
    return group.members.map((m) => OB11Constructor.groupMember(group.groupCode, m))
  }

  static group(group: Group): OB11Group {
    return {
      group_id: parseInt(group.groupCode),
      group_name: group.groupName,
      member_count: group.memberCount,
      max_member_count: group.maxMember,
    }
  }

  static groups(groups: Group[]): OB11Group[] {
    return groups.map(OB11Constructor.group)
  }
}
