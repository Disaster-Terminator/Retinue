export interface TextTail {
    text: string;
    bytes: number;
    truncated: boolean;
}
export declare const MAX_TEXT_TAIL_BYTES: number;
export declare function readTextTailIfExists(filePath: string, maxBytes: number): Promise<TextTail>;
export declare function limitUtf8Suffix(text: string, maxBytes: number): {
    text: string;
    truncated: boolean;
};
