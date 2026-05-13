export interface TextTail {
    text: string;
    bytes: number;
    truncated: boolean;
}
export declare function readTextTailIfExists(filePath: string, maxBytes: number): Promise<TextTail>;
export declare function limitUtf8Suffix(text: string, maxBytes: number): {
    text: string;
    truncated: boolean;
};
