/**
 * Persisted query SHA-256 hashes and GraphQL operation documents
 * matching PlayerOK's frontend GraphQL contract (from playerokapi/misc.py).
 */
export const PERSISTED_QUERIES = {
  viewerBalance: 'a11039bbf514e8b9cb9901efbd81553574fab3bdcb75713afec40fb8de676d10',
  user: '48cadfa521497f9445eaa9abda29a4251149636d9393f536165889a61e332384',
  userChats: 'c1ddbcd7c8b87160ac25e0734f9dc32fc945287b056f4b14abf1473bfb1ad11a',
  deals: '591b0e6d036c2120c8f95b97dbfdf5635df3747cd901f4895e009935229417ef',
  deal: 'd0421fb8dea49652876d69b1a14ce2c715ea9c7127c48c85a78e06de31a845ae',
  testimonials: '773d40b7efec82a4b86021ba8bcaa462f68eb236e255926f2168c5cd4685e881',
  chat: 'bb024dc0652fc7c1302a64a117d56d99fb0d726eb4b896ca803dca55f611d933',
  chatMessages: '9b4e264ff1b20e0fd3929afe023dee8f50affc02b85f80cb4b3dc1516ecfbaa0',
  items: '3f20c731f8f769a094ee3fa32e09f8e12250357e9a4f0ebb4e6988e7a0bb9260',
  item: '1cdb4b335f6c119db77883451f41cef83fc449f79f021627f27b76ec49203487',
  itemPriorityStatuses: 'b922220c6f979537e1b99de6af8f5c13727daeff66727f679f07f986ce1c025a',
  transactions: '63672f5d6b617b27fe213cd5dec566e4ee90df9ea79080b74c5e6b6e9d448568',
  SbpBankMembers: 'ef7902598e855fa15fb5e3112156ac226180f0b009a36606fc80a18f00b80c63',
  verifiedCards: 'eb338d8432981307a2b3d322b3310b2447cab3a6acf21aba4b8773b97e72d1aa',
  messageTemplates: 'f3d4b4053f7c758d4cd84429bbf974a27b0afed6a473ab47fbe8d13ac6bf87a2',
} as const;

export const GQL_QUERIES = {
  viewer: `query viewer {
    viewer {
      id username email role hasFrozenBalance supportChatId systemChatId
      unreadChatsCounter isBlocked isBlockedFor createdAt lastItemCreatedAt
      hasConfirmedPhoneNumber canPublishItems
      balance { value }
      profile { id avatarURL testimonialCounter }
    }
  }`,

  markChatAsRead: `mutation markChatAsRead($input: MarkChatAsReadInput!) {
    markChatAsRead(input: $input) {
      id type status unreadMessagesCounter
      participants { id username role avatarURL isOnline isBlocked }
    }
  }`,

  uploadChatImageIntoTemporaryStore: `mutation uploadChatImageIntoTemporaryStore($file: Upload!, $input: UploadTemporaryAttachmentInput!) {
    uploadChatImageIntoTemporaryStore(file: $file, input: $input) {
      id url chatId clientAttachmentId expiresAt
    }
  }`,

  createChatMessage: `mutation createChatMessage($input: CreateChatMessageInput!) {
    createChatMessage(input: $input) {
      id text createdAt isRead
      user { id username role avatarURL isOnline isBlocked }
      images { id url filename mime }
    }
  }`,

  updateDeal: `mutation updateDeal($input: UpdateItemDealInput!) {
    updateDeal(input: $input) {
      id status direction hasProblem createdAt completedAt
      user { id username role isOnline isBlocked }
      chat { id }
      item { id slug name price rawPrice priority status }
      testimonial { id status text rating createdAt creator { id username } }
    }
  }`,

  reportDealProblem: `mutation reportDealProblem($input: ReportDealProblemInput!) {
    reportDealProblem(input: $input) {
      id status direction hasProblem
      user { id username }
      item { id slug name price rawPrice }
    }
  }`,

  createItem: `mutation createItem($input: CreateItemInput!, $attachments: [Upload!]!) {
    createItem(input: $input, attachments: $attachments) {
      id slug name description rawPrice price status priority sequence mayBePublished
      user { id username }
    }
  }`,

  updateItem: `mutation updateItem($input: UpdateItemInput!) {
    updateItem(input: $input) {
      id slug name description rawPrice price status priority sequence mayBePublished
      dataFields { id label type value hidden }
    }
  }`,

  removeItem: `mutation removeItem($id: UUID!) {
    removeItem(id: $id) { id }
  }`,

  publishItem: `mutation publishItem($input: PublishItemInput!) {
    publishItem(input: $input) {
      id slug name rawPrice price status priority sequence mayBePublished
    }
  }`,

  increaseItemPriorityStatus: `mutation increaseItemPriorityStatus($input: PublishItemInput!) {
    increaseItemPriorityStatus(input: $input) {
      id slug name rawPrice price status priority sequence
    }
  }`,

  requestWithdrawal: `mutation requestWithdrawal($input: CreateWithdrawalTransactionInput!) {
    requestWithdrawal(input: $input) {
      id operation direction providerId status value fee createdAt
    }
  }`,

  removeTransaction: `mutation removeTransaction($id: UUID!) {
    removeTransaction(id: $id) {
      id operation direction providerId status value createdAt
    }
  }`,

  userUpdated: `subscription userUpdated($userId: UUID) {
    userUpdated(userId: $userId) {
      __typename
      ... on User { id unreadChatsCounter }
      ... on UserFragment { id }
    }
  }`,

  chatUpdated: `subscription chatUpdated($filter: ChatFilter) {
    chatUpdated(filter: $filter) {
      id unreadMessagesCounter status
      lastMessage {
        id text createdAt isRead
        user { id username }
        images { id url filename mime }
        deal { id status direction user { id username } item { id slug name price rawPrice priority status } }
      }
    }
  }`,

  chatMessageCreated: `subscription chatMessageCreated($filter: ChatMessageWSFilter!) {
    chatMessageCreated(filter: $filter) {
      id text createdAt isRead
      user { id username }
      images { id url filename mime }
      deal { id status direction user { id username } item { id slug name price rawPrice priority status } }
    }
  }`,
} as const;
